import { randomUUID } from 'node:crypto';
import { logger } from './config/logger.js';
import {
  createCalendarSyncHandler,
  createCalendarDeleteHandler,
  createCalendarWorkProjector,
  createGoogleCalendarGateway,
} from './modules/calendar/calendar.service.js';
import {
  createEmailApprovalProjector,
  createEmailDeliveryHandler,
  createEmailRejectionProjector,
  createReminderProjector,
  createGoogleGmailGateway,
  migrateOutboxRecipientIndex,
  runEmailProjectionBackfill,
  runReminderProjectionBackfill,
} from './modules/email/email.service.js';
import {
  claimNextEvent,
  defaultWorkerOptions,
  processClaimedEvent,
  runOutboxWorker,
  type OutboxHandlers,
} from './modules/outbox/outbox.service.js';

/** Maximum number of events processed in a single scheduler tick pass. */
const TICK_BATCH_LIMIT = 20;

export interface WorkerHandle {
  /**
   * Worker ID (UUID), useful for log correlation.
   */
  readonly workerId: string;
  /**
   * Resolves when the worker has fully stopped (after stop() is called).
   * The promise rejects if the worker exits with an unexpected error.
   */
  readonly stopped: Promise<void>;
  /**
   * Signal the worker polling loop to stop gracefully.
   * Safe to call multiple times.
   */
  stop(): void;
  /**
   * Process a bounded batch of currently eligible outbox work immediately.
   * Intended exclusively for the secure internal scheduler tick endpoint.
   * Runs up to TICK_BATCH_LIMIT events sequentially using the worker's
   * own handlers and lease semantics.
   * Returns when the batch is complete or no eligible work remains.
   * Does nothing if the worker is stopping or has stopped.
   */
  tick(): Promise<void>;
}

/**
 * Build the shared outbox handler map from Google integrations.
 *
 * Called once during worker startup. Calls requireCalendarConfig() and
 * requireGmailConfig() which will throw if credentials are absent —
 * this is intentional: the worker must not silently degrade.
 */
function buildHandlers(): OutboxHandlers {
  const calendarGateway = createGoogleCalendarGateway();
  const gmailGateway = createGoogleGmailGateway();
  const calendarProjector = createCalendarWorkProjector();
  const emailApprovalProjector = createEmailApprovalProjector();
  const reminderProjector = createReminderProjector();

  return {
    BOOKING_APPROVED: async (event) => {
      await calendarProjector(event);
      await emailApprovalProjector(event);
      await reminderProjector(event);
    },
    BOOKING_REJECTED: createEmailRejectionProjector(),
    CALENDAR_BOOKING_CREATE: createCalendarSyncHandler(calendarGateway),
    CALENDAR_BOOKING_DELETE: createCalendarDeleteHandler(calendarGateway),
    EMAIL_BOOKING_APPROVED: createEmailDeliveryHandler(gmailGateway),
    EMAIL_BOOKING_REJECTED: createEmailDeliveryHandler(gmailGateway),
    EMAIL_BOOKING_REMINDER_24H: createEmailDeliveryHandler(gmailGateway),
    EMAIL_BOOKING_REMINDER_3H: createEmailDeliveryHandler(gmailGateway),
  };
}

/**
 * Start the durable outbox background worker and return a handle.
 *
 * Runs index migration, email and reminder projection backfills, then
 * starts the polling loop. The returned handle lets the caller stop the
 * worker and invoke a bounded scheduler tick.
 *
 * Do NOT call from automated tests: this function instantiates real
 * Google API clients via requireCalendarConfig / requireGmailConfig.
 */
export function startWorkerProcess(): WorkerHandle {
  const workerId = randomUUID();
  const controller = new AbortController();
  let stopping = false;
  const handlers = buildHandlers();
  let tickInFlight = false;

  const stopped: Promise<void> = (async () => {
    await migrateOutboxRecipientIndex();
    await Promise.all([
      runEmailProjectionBackfill(controller.signal),
      runReminderProjectionBackfill(controller.signal),
      runOutboxWorker({ workerId, handlers, signal: controller.signal }),
    ]);
  })().then(
    () => {
      logger.info({ workerId }, 'Embedded worker exited cleanly');
    },
    (err: unknown) => {
      logger.error(
        {
          workerId,
          errorName: err instanceof Error ? err.name : 'UnknownError',
        },
        'Embedded worker exited with error',
      );
      // Re-throw so the stopped promise rejects and server.ts can react.
      throw err;
    },
  );

  return {
    workerId,
    stopped,

    stop() {
      if (stopping) return;
      stopping = true;
      logger.info({ workerId }, 'Embedded worker stop requested');
      controller.abort();
    },

    async tick() {
      if (stopping || controller.signal.aborted) return;
      if (tickInFlight) {
        logger.debug({ workerId }, 'Scheduler tick skipped: previous tick in flight');
        return;
      }
      tickInFlight = true;
      logger.info({ workerId }, 'Scheduler tick: processing eligible work');
      try {
        let processed = 0;
        while (processed < TICK_BATCH_LIMIT && !controller.signal.aborted) {
          const event = await claimNextEvent(
            workerId,
            handlers,
            new Date(),
            defaultWorkerOptions,
          );
          if (!event) break;
          await processClaimedEvent(
            event,
            workerId,
            handlers,
            () => new Date(),
            defaultWorkerOptions,
            controller.signal,
          );
          processed++;
        }
        logger.info({ workerId, processed }, 'Scheduler tick complete');
      } finally {
        tickInFlight = false;
      }
    },
  };
}
