import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { connectDatabase, disconnectDatabase } from './config/database.js';
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
  runOutboxWorker,
  type OutboxHandlers,
} from './modules/outbox/outbox.service.js';

const calendarGateway = createGoogleCalendarGateway();
const gmailGateway = createGoogleGmailGateway();
const calendarProjector = createCalendarWorkProjector();
const emailApprovalProjector = createEmailApprovalProjector();
const reminderProjector = createReminderProjector();
const handlers: OutboxHandlers = {
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
const workerId = randomUUID();
const controller = new AbortController();
let stopping = false;
let workerPromise: Promise<void> | undefined;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal, workerId }, 'Outbox worker shutdown requested');
  controller.abort();
  const forceExit = setTimeout(() => {
    logger.error({ workerId }, 'Outbox worker did not stop within 10 seconds');
    void disconnectDatabase().finally(() => process.exit(1));
  }, 10_000);
  forceExit.unref();
  try {
    await workerPromise;
    clearTimeout(forceExit);
    await disconnectDatabase();
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    logger.error(
      {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        workerId,
      },
      'Outbox worker shutdown failed',
    );
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await connectDatabase();
  await migrateOutboxRecipientIndex();
  const backfillController = controller;
  const backfillPromise = runEmailProjectionBackfill(backfillController.signal);
  const reminderBackfillPromise = runReminderProjectionBackfill(
    backfillController.signal,
  );
  workerPromise = Promise.all([
    backfillPromise,
    reminderBackfillPromise,
    runOutboxWorker({
      workerId,
      handlers,
      signal: controller.signal,
    }),
  ]).then(() => undefined);
  await workerPromise;
  await disconnectDatabase();
} catch (error) {
  logger.fatal(
    {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      workerId,
    },
    'Outbox worker startup failed',
  );
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
}
