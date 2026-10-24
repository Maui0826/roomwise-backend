import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  OUTBOX_EVENT_TYPES,
  OutboxEvent,
  type BookingOutboxEventType,
  type BookingDecisionEventType,
  type OutboxEventRecord,
  type OutboxPayload,
} from './outbox.model.js';

export type Clock = () => Date;
export type OutboxHandler = (
  event: Readonly<OutboxEventRecord>,
  signal?: AbortSignal,
) => Promise<void>;
export type OutboxHandlers = Partial<
  Record<BookingOutboxEventType, OutboxHandler>
>;

export interface OutboxWorkerOptions {
  pollIntervalMs: number;
  lockTimeoutMs: number;
  retryBaseDelayMs: number;
}

export const defaultWorkerOptions: OutboxWorkerOptions = {
  pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
  lockTimeoutMs: env.OUTBOX_LOCK_TIMEOUT_MS,
  retryBaseDelayMs: env.OUTBOX_RETRY_BASE_DELAY_MS,
};

export class OutboxHandlerError extends Error {
  readonly retryable: boolean;
  readonly errorCode: string;
  readonly retryAfterMs?: number;

  constructor(errorCode: string, retryable: boolean, retryAfterMs?: number) {
    super(errorCode);
    this.name = 'OutboxHandlerError';
    this.errorCode = sanitizeErrorCode(errorCode);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function createBookingDecisionEvent(
  eventType: BookingDecisionEventType,
  bookingId: string,
  occurredAt: Date,
  session: ClientSession,
): Promise<void> {
  const payload: OutboxPayload = { bookingId, occurredAt };
  await OutboxEvent.create(
    [
      {
        eventType,
        aggregateType: 'BOOKING',
        aggregateId: bookingId,
        payload,
        status: 'PENDING',
        availableAt: occurredAt,
        attemptCount: 0,
        maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
      },
    ],
    { session },
  );
}

export async function createCalendarDeletionEvent(
  bookingId: string,
  occurredAt: Date,
  maxAttempts: number,
  session: ClientSession,
): Promise<void> {
  await OutboxEvent.create(
    [
      {
        eventType: 'CALENDAR_BOOKING_DELETE',
        aggregateType: 'BOOKING',
        aggregateId: bookingId,
        payload: { bookingId, occurredAt },
        status: 'PENDING',
        availableAt: occurredAt,
        attemptCount: 0,
        maxAttempts,
      },
    ],
    { session },
  );
}

export async function claimNextEvent(
  workerId: string,
  handlers: OutboxHandlers,
  now = new Date(),
  options: OutboxWorkerOptions = defaultWorkerOptions,
): Promise<OutboxEventRecord | null> {
  const enabledTypes = Object.keys(handlers);
  const routable = enabledTypes.length
    ? {
        $or: [
          { eventType: { $in: enabledTypes } },
          { eventType: { $nin: OUTBOX_EVENT_TYPES } },
        ],
      }
    : { eventType: { $nin: OUTBOX_EVENT_TYPES } };
  const staleBefore = new Date(now.getTime() - options.lockTimeoutMs);
  const disabledTypes = OUTBOX_EVENT_TYPES.filter(
    (eventType) => !enabledTypes.includes(eventType),
  );
  if (disabledTypes.length) {
    const requeued = await OutboxEvent.updateMany(
      {
        status: 'PROCESSING',
        lockedAt: { $lte: staleBefore },
        eventType: { $in: disabledTypes },
      },
      {
        $set: {
          status: 'PENDING',
          availableAt: now,
          attemptCount: 0,
          lockedAt: null,
          lockedBy: null,
          lastError: 'HANDLER_NOT_ENABLED',
        },
      },
    );
    if (requeued.modifiedCount) {
      logger.warn(
        { count: requeued.modifiedCount, workerId },
        'Stale events returned to pending because handlers are disabled',
      );
    }
  }

  const exhausted = await OutboxEvent.updateMany(
    {
      status: 'PROCESSING',
      lockedAt: { $lte: staleBefore },
      $expr: { $gte: ['$attemptCount', '$maxAttempts'] },
    },
    {
      $set: {
        status: 'FAILED',
        lockedAt: null,
        lockedBy: null,
        lastError: 'ATTEMPTS_EXHAUSTED_AFTER_LEASE',
      },
    },
  );
  if (exhausted.modifiedCount) {
    logger.error(
      { count: exhausted.modifiedCount, workerId },
      'Expired outbox leases exhausted their attempts',
    );
  }

  const update = {
    $set: { status: 'PROCESSING', lockedAt: now, lockedBy: workerId },
  };
  const common = {
    $and: [routable, { $expr: { $lt: ['$attemptCount', '$maxAttempts'] } }],
  };

  // Prefer expired leases so abandoned work is recovered promptly.
  const reclaimed = await OutboxEvent.findOneAndUpdate(
    {
      ...common,
      status: 'PROCESSING',
      lockedAt: { $lte: staleBefore },
    },
    update,
    { returnDocument: 'after', sort: { lockedAt: 1, createdAt: 1 } },
  ).lean<OutboxEventRecord>();
  const event =
    reclaimed ??
    (await OutboxEvent.findOneAndUpdate(
      {
        ...common,
        status: 'PENDING',
        availableAt: { $lte: now },
      },
      update,
      { returnDocument: 'after', sort: { availableAt: 1, createdAt: 1 } },
    ).lean<OutboxEventRecord>());

  if (!event) return null;
  logger.info(
    {
      eventId: String(event._id),
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: String(event.aggregateId),
      attemptCount: event.attemptCount,
      workerId,
      staleReclaimed: Boolean(reclaimed),
    },
    reclaimed ? 'Outbox lease reclaimed' : 'Outbox event claimed',
  );
  return event;
}

export async function processClaimedEvent(
  event: OutboxEventRecord,
  workerId: string,
  handlers: OutboxHandlers,
  clock: Clock = () => new Date(),
  options: OutboxWorkerOptions = defaultWorkerOptions,
  signal?: AbortSignal,
): Promise<void> {
  const execution = await OutboxEvent.findOneAndUpdate(
    ownershipFilter(event, workerId),
    { $inc: { attemptCount: 1 } },
    { returnDocument: 'after' },
  ).lean<OutboxEventRecord>();
  if (!execution) return;
  event = execution;

  const handler = handlers[event.eventType as BookingOutboxEventType];
  if (!handler) {
    await finalizeFailure(event, workerId, 'UNSUPPORTED_EVENT_TYPE');
    return;
  }

  try {
    await handler(event, signal);
    const finalized = await OutboxEvent.updateOne(
      ownershipFilter(event, workerId),
      {
        $set: {
          status: 'PROCESSED',
          processedAt: clock(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      },
    );
    if (!finalized.matchedCount) return;
    logger.info(
      {
        eventId: String(event._id),
        eventType: event.eventType,
        aggregateId: String(event.aggregateId),
        attemptCount: event.attemptCount,
        workerId,
      },
      'Outbox event processed',
    );
  } catch (error) {
    const retryable = !(error instanceof OutboxHandlerError) || error.retryable;
    const errorCode =
      error instanceof OutboxHandlerError
        ? error.errorCode
        : 'UNEXPECTED_HANDLER_ERROR';
    const canRetry = retryable && event.attemptCount < event.maxAttempts;
    if (canRetry) {
      const delay = Math.max(
        retryDelayMs(event.attemptCount, options.retryBaseDelayMs),
        error instanceof OutboxHandlerError ? (error.retryAfterMs ?? 0) : 0,
      );
      const availableAt = new Date(clock().getTime() + delay);
      const scheduled = await OutboxEvent.updateOne(
        ownershipFilter(event, workerId),
        {
          $set: {
            status: 'PENDING',
            availableAt,
            lockedAt: null,
            lockedBy: null,
            lastError: errorCode,
          },
        },
      );
      if (!scheduled.matchedCount) return;
      logger.warn(
        {
          eventId: String(event._id),
          eventType: event.eventType,
          aggregateId: String(event.aggregateId),
          attemptCount: event.attemptCount,
          workerId,
          errorCode,
          retryDelayMs: delay,
        },
        'Outbox retry scheduled',
      );
      return;
    }
    await finalizeFailure(event, workerId, errorCode);
  }
}

export function retryDelayMs(
  attemptCount: number,
  baseDelayMs: number,
): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 16));
  return Math.min(baseDelayMs * 2 ** exponent, 3_600_000);
}

export async function runOutboxWorker(options: {
  workerId?: string;
  handlers: OutboxHandlers;
  signal: AbortSignal;
  workerOptions?: OutboxWorkerOptions;
  clock?: Clock;
}): Promise<void> {
  const workerId = options.workerId ?? randomUUID();
  const workerOptions = options.workerOptions ?? defaultWorkerOptions;
  const clock = options.clock ?? (() => new Date());
  logger.info({ workerId }, 'Outbox worker started');
  try {
    while (!options.signal.aborted) {
      const event = await claimNextEvent(
        workerId,
        options.handlers,
        clock(),
        workerOptions,
      );
      if (event) {
        await processClaimedEvent(
          event,
          workerId,
          options.handlers,
          clock,
          workerOptions,
          options.signal,
        );
      } else {
        await sleep(workerOptions.pollIntervalMs, options.signal);
      }
    }
  } finally {
    logger.info({ workerId }, 'Outbox worker stopped');
  }
}

async function finalizeFailure(
  event: OutboxEventRecord,
  workerId: string,
  errorCode: string,
): Promise<void> {
  const failed = await OutboxEvent.updateOne(ownershipFilter(event, workerId), {
    $set: {
      status: 'FAILED',
      lockedAt: null,
      lockedBy: null,
      lastError: sanitizeErrorCode(errorCode),
    },
  });
  if (!failed.matchedCount) return;
  logger.error(
    {
      eventId: String(event._id),
      eventType: event.eventType,
      aggregateId: String(event.aggregateId),
      attemptCount: event.attemptCount,
      workerId,
      errorCode: sanitizeErrorCode(errorCode),
    },
    'Outbox event permanently failed',
  );
}

function ownershipFilter(event: OutboxEventRecord, workerId: string) {
  return {
    _id: event._id,
    status: 'PROCESSING' as const,
    lockedBy: workerId,
    lockedAt: event.lockedAt,
  };
}

function sanitizeErrorCode(value: string): string {
  const sanitized = value
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 80);
  return sanitized || 'HANDLER_ERROR';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
