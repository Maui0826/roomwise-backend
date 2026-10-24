import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { google } from 'googleapis';
import { z } from 'zod';
import { env, requireGmailConfig } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { Booking } from '../bookings/booking.model.js';
import { Room } from '../rooms/room.model.js';
import { User } from '../users/user.model.js';
import { OutboxEvent, type OutboxEventRecord } from '../outbox/outbox.model.js';
import {
  OutboxHandlerError,
  type OutboxHandler,
} from '../outbox/outbox.service.js';
import { EmailProjection } from './email-projection.model.js';
import { ReminderProjection } from './reminder-projection.model.js';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const DOMAIN_EVENT_TYPES = ['BOOKING_APPROVED', 'BOOKING_REJECTED'] as const;
const EMAIL_PROJECTION_RETRY_INTERVAL_MS = 30_000;
const EMAIL_PROJECTION_BATCH_SIZE = 100;
const REMINDER_PROJECTION_BATCH_SIZE = 100;
const safeEmailSchema = z.string().trim().email().max(254);

type EmailEventType = 'EMAIL_BOOKING_APPROVED' | 'EMAIL_BOOKING_REJECTED';
export type ReminderEventType =
  'EMAIL_BOOKING_REMINDER_24H' | 'EMAIL_BOOKING_REMINDER_3H';
type DeliveryEventType = EmailEventType | ReminderEventType;
type RecipientRole = 'REQUESTER' | 'GUEST';
const HOUR_MS = 60 * 60 * 1000;

export function calculateReminderDueTimes(startAt: Date): {
  reminder24hDueAt: Date;
  reminder3hDueAt: Date;
} {
  return {
    reminder24hDueAt: new Date(startAt.getTime() - 24 * HOUR_MS),
    reminder3hDueAt: new Date(startAt.getTime() - 3 * HOUR_MS),
  };
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  messageId: string;
}
export interface GmailGateway {
  sendMessage(message: OutgoingEmail): Promise<{ messageId?: string }>;
}

export function createGoogleGmailGateway(): GmailGateway {
  const config = requireGmailConfig();
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
  auth.setCredentials({ refresh_token: config.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });
  return {
    async sendMessage(message) {
      const raw = encodeMimeMessage({ ...message, from: config.senderEmail });
      try {
        const response = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw },
        });
        return { messageId: response.data.id ?? undefined };
      } catch (error) {
        throw classifyGmailError(error);
      }
    },
  };
}

export function createEmailApprovalProjector(): OutboxHandler {
  return (event) => projectEmailDecision(event, 'BOOKING_APPROVED');
}
export function createEmailRejectionProjector(): OutboxHandler {
  return (event) => projectEmailDecision(event, 'BOOKING_REJECTED');
}

export function createReminderProjector(
  clock: () => Date = () => new Date(),
): OutboxHandler {
  return (event) => projectBookingReminders(event, clock);
}

async function projectBookingReminders(
  event: Readonly<OutboxEventRecord>,
  clock: () => Date,
): Promise<void> {
  if (
    event.eventType !== 'BOOKING_APPROVED' ||
    event.payload.bookingId !== String(event.aggregateId)
  ) {
    throw new OutboxHandlerError('INVALID_REMINDER_SOURCE_EVENT', false);
  }
  if (
    await ReminderProjection.exists({
      consumer: 'REMINDERS',
      sourceEventId: event._id,
    })
  )
    return;

  const booking = await Booking.findById(event.aggregateId);
  if (!booking) {
    await markReminderProjection(event._id, 'FAILED', 'BOOKING_NOT_FOUND');
    logger.error(
      {
        bookingId: String(event.aggregateId),
        sourceEventId: String(event._id),
      },
      'Reminder projection could not find its Booking',
    );
    return;
  }
  if (booking.status !== 'APPROVED') {
    await markReminderProjection(
      event._id,
      'FAILED',
      'BOOKING_STATUS_MISMATCH',
    );
    logger.error(
      {
        bookingId: String(event.aggregateId),
        sourceEventId: String(event._id),
      },
      'Reminder projection found a mismatched Booking status',
    );
    return;
  }

  const requester = await User.findById(booking.requester).select('email');
  if (!requester) {
    await markReminderProjection(event._id, 'FAILED', 'REQUESTER_NOT_FOUND');
    logger.error(
      {
        bookingId: String(event.aggregateId),
        sourceEventId: String(event._id),
      },
      'Reminder projection could not find the Booking requester',
    );
    return;
  }

  const recipients = getNotificationRecipients(
    requester.email,
    booking.guests.map((guest) => guest.email),
    true,
  );
  const { reminder24hDueAt, reminder3hDueAt } = calculateReminderDueTimes(
    booking.startAt,
  );
  const projectedAt = clock();
  const eligible: Array<{ eventType: ReminderEventType; dueAt: Date }> = [];
  if (reminder24hDueAt > projectedAt)
    eligible.push({
      eventType: 'EMAIL_BOOKING_REMINDER_24H',
      dueAt: reminder24hDueAt,
    });
  if (reminder3hDueAt > projectedAt)
    eligible.push({
      eventType: 'EMAIL_BOOKING_REMINDER_3H',
      dueAt: reminder3hDueAt,
    });

  for (const reminder of eligible) {
    for (const recipient of recipients) {
      await upsertRecipientWork({
        eventType: reminder.eventType,
        bookingId: String(booking._id),
        recipient: recipient.email,
        recipientRole: recipient.role,
        occurredAt: event.payload.occurredAt,
        sourceEventId: String(event._id),
        maxAttempts: event.maxAttempts,
        availableAt: reminder.dueAt,
      });
    }
  }
  await markReminderProjection(event._id, 'PROJECTED', null);
}

async function projectEmailDecision(
  event: Readonly<OutboxEventRecord>,
  expectedType: (typeof DOMAIN_EVENT_TYPES)[number],
): Promise<void> {
  if (
    event.eventType !== expectedType ||
    event.payload.bookingId !== String(event.aggregateId)
  ) {
    throw new OutboxHandlerError('INVALID_EMAIL_SOURCE_EVENT', false);
  }
  if (
    await EmailProjection.exists({
      consumer: 'EMAIL',
      sourceEventId: event._id,
    })
  )
    return;

  const booking = await Booking.findById(event.aggregateId);
  if (!booking) {
    await markProjection(event._id, 'FAILED', 'BOOKING_NOT_FOUND');
    logger.error(
      {
        bookingId: String(event.aggregateId),
        sourceEventId: String(event._id),
      },
      'Email notification projection could not find its Booking',
    );
    return;
  }
  const expectedStatus =
    expectedType === 'BOOKING_APPROVED' ? 'APPROVED' : 'REJECTED';
  if (booking.status !== expectedStatus) {
    await markProjection(event._id, 'FAILED', 'BOOKING_STATUS_MISMATCH');
    logger.error(
      {
        bookingId: String(event.aggregateId),
        sourceEventId: String(event._id),
      },
      'Email notification projection found a mismatched Booking status',
    );
    return;
  }

  const [requester, room] = await Promise.all([
    User.findById(booking.requester).select('name email'),
    Room.findById(booking.room).select('name location'),
  ]);
  if (!requester || !room) {
    await markProjection(
      event._id,
      'FAILED',
      requester ? 'ROOM_NOT_FOUND' : 'REQUESTER_NOT_FOUND',
    );
    logger.error(
      {
        bookingId: String(event.aggregateId),
        sourceEventId: String(event._id),
      },
      'Email notification projection is missing required Booking references',
    );
    return;
  }
  const recipients = getNotificationRecipients(
    requester.email,
    booking.guests.map((guest) => guest.email),
    expectedType === 'BOOKING_APPROVED',
  );
  const emailEventType: EmailEventType =
    expectedType === 'BOOKING_APPROVED'
      ? 'EMAIL_BOOKING_APPROVED'
      : 'EMAIL_BOOKING_REJECTED';
  for (const recipient of recipients) {
    await upsertRecipientWork({
      eventType: emailEventType,
      bookingId: String(booking._id),
      recipient: recipient.email,
      recipientRole: recipient.role,
      occurredAt: event.payload.occurredAt,
      sourceEventId: String(event._id),
      maxAttempts: event.maxAttempts,
    });
  }
  await markProjection(event._id, 'PROJECTED', null);
}

function getNotificationRecipients(
  requesterEmail: string,
  guestEmails: string[],
  includeGuests: boolean,
): Array<{ email: string; role: RecipientRole }> {
  const requester = normalizeAddress(requesterEmail);
  const recipients = new Map<string, RecipientRole>([[requester, 'REQUESTER']]);
  if (includeGuests) {
    for (const guestEmail of guestEmails) {
      const email = normalizeAddress(guestEmail);
      if (!recipients.has(email)) recipients.set(email, 'GUEST');
    }
  }
  return [...recipients].map(([email, role]) => ({ email, role }));
}

function normalizeAddress(value: string): string {
  const email = value.trim().toLowerCase();
  if (!safeEmailSchema.safeParse(email).success)
    throw new OutboxHandlerError('INVALID_NOTIFICATION_ADDRESS', false);
  return email;
}

async function upsertRecipientWork(input: {
  eventType: DeliveryEventType;
  bookingId: string;
  recipient: string;
  recipientRole: RecipientRole;
  occurredAt: Date;
  sourceEventId: string;
  maxAttempts: number;
  availableAt?: Date;
}): Promise<void> {
  const recipientKey = createHash('sha256')
    .update(input.recipient)
    .digest('hex');
  const identity = {
    eventType: input.eventType,
    aggregateType: 'BOOKING',
    aggregateId: input.bookingId,
    'payload.recipientKey': recipientKey,
  };
  try {
    await OutboxEvent.updateOne(
      identity,
      {
        $setOnInsert: {
          eventType: input.eventType,
          aggregateType: 'BOOKING',
          aggregateId: input.bookingId,
          payload: {
            bookingId: input.bookingId,
            occurredAt: input.occurredAt,
            sourceEventId: input.sourceEventId,
            recipientEmail: input.recipient,
            recipientKey,
            recipientRole: input.recipientRole,
          },
          status: 'PENDING',
          availableAt: input.availableAt ?? new Date(),
          attemptCount: 0,
          maxAttempts: input.maxAttempts,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await OutboxEvent.exists(identity);
    if (!existing)
      throw new OutboxHandlerError('EMAIL_WORK_UPSERT_FAILED', true);
  }
}

async function markReminderProjection(
  sourceEventId: OutboxEventRecord['_id'],
  status: 'PROJECTED' | 'FAILED',
  errorCode: string | null,
): Promise<void> {
  try {
    await ReminderProjection.updateOne(
      { consumer: 'REMINDERS', sourceEventId },
      {
        $setOnInsert: {
          consumer: 'REMINDERS',
          sourceEventId,
          status,
          errorCode,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (isDuplicateKey(error)) return;
    throw error;
  }
}

async function markProjection(
  sourceEventId: OutboxEventRecord['_id'],
  status: 'PROJECTED' | 'FAILED',
  errorCode: string | null,
): Promise<void> {
  try {
    await EmailProjection.updateOne(
      { consumer: 'EMAIL', sourceEventId },
      { $setOnInsert: { consumer: 'EMAIL', sourceEventId, status, errorCode } },
      { upsert: true },
    );
  } catch (error) {
    if (isDuplicateKey(error)) return;
    throw error;
  }
}

export function createEmailDeliveryHandler(
  gateway: GmailGateway,
  clock: () => Date = () => new Date(),
): OutboxHandler {
  return async (event) => deliverNotification(event, gateway, clock);
}

async function deliverNotification(
  event: Readonly<OutboxEventRecord>,
  gateway: GmailGateway,
  clock: () => Date,
): Promise<void> {
  const approved = event.eventType === 'EMAIL_BOOKING_APPROVED';
  const rejected = event.eventType === 'EMAIL_BOOKING_REJECTED';
  const reminder24h = event.eventType === 'EMAIL_BOOKING_REMINDER_24H';
  const reminder3h = event.eventType === 'EMAIL_BOOKING_REMINDER_3H';
  const reminder = reminder24h || reminder3h;
  if (
    (!approved && !rejected && !reminder) ||
    event.payload.bookingId !== String(event.aggregateId) ||
    !event.payload.recipientEmail ||
    !event.payload.recipientKey ||
    !event.payload.recipientRole
  ) {
    throw new OutboxHandlerError('INVALID_EMAIL_WORK', false);
  }
  if (event.sentAt) return;
  const recipient = normalizeAddress(event.payload.recipientEmail);
  const key = createHash('sha256').update(recipient).digest('hex');
  if (key !== event.payload.recipientKey)
    throw new OutboxHandlerError('EMAIL_RECIPIENT_IDENTITY_MISMATCH', false);

  const booking = await Booking.findById(event.payload.bookingId);
  if (!booking) throw new OutboxHandlerError('BOOKING_NOT_FOUND', false);
  const requiredStatus = rejected ? 'REJECTED' : 'APPROVED';
  if (booking.status !== requiredStatus) {
    if (reminder) {
      await persistDeliveryOutcome(event, 'SKIPPED_INVALID_STATE');
      logReminderSkip(event, 'SKIPPED_INVALID_STATE');
      return;
    }
    throw new OutboxHandlerError('BOOKING_STATUS_MISMATCH', false);
  }
  const [requester, room] = await Promise.all([
    User.findById(booking.requester).select('name email'),
    Room.findById(booking.room).select('name location'),
  ]);
  if (!requester) throw new OutboxHandlerError('REQUESTER_NOT_FOUND', false);
  if (!room) throw new OutboxHandlerError('ROOM_NOT_FOUND', false);
  const requesterEmail = normalizeAddress(requester.email);
  const isRequester = recipient === requesterEmail;
  const guestEmails = booking.guests.map((guest) =>
    normalizeAddress(guest.email),
  );
  const legitimate =
    approved || reminder
      ? isRequester || guestEmails.includes(recipient)
      : isRequester;
  if (!legitimate)
    throw new OutboxHandlerError('EMAIL_RECIPIENT_NOT_AUTHORIZED', false);
  if (isRequester && event.payload.recipientRole !== 'REQUESTER')
    throw new OutboxHandlerError('EMAIL_RECIPIENT_ROLE_MISMATCH', false);
  if (!isRequester && event.payload.recipientRole !== 'GUEST')
    throw new OutboxHandlerError('EMAIL_RECIPIENT_ROLE_MISMATCH', false);

  const message: OutgoingEmail = {
    to: recipient,
    subject: reminder24h
      ? 'Booking Reminder - 24 Hours'
      : reminder3h
        ? 'Booking Reminder - 3 Hours'
        : approved
          ? 'Booking Request Approved'
          : 'Booking Request Rejected',
    text: buildNotificationText({
      approved: approved || reminder,
      reminderHours: reminder24h ? 24 : reminder3h ? 3 : null,
      recipientName: isRequester
        ? requester.name
        : booking.guests.find(
            (guest) => normalizeAddress(guest.email) === recipient,
          )?.name,
      requesterName: requester.name,
      roomName: room.name,
      roomLocation: room.location,
      startAt: booking.startAt,
      endAt: booking.endAt,
      description: booking.description,
      rejectionReason: booking.rejectionReason,
      includeRequester: !isRequester,
    }),
    messageId: deterministicMessageId(
      event.eventType,
      String(booking._id),
      key,
    ),
  };
  if (reminder && clock() >= booking.startAt) {
    await persistDeliveryOutcome(event, 'SKIPPED_BOOKING_STARTED');
    logReminderSkip(event, 'SKIPPED_BOOKING_STARTED');
    return;
  }
  const result = await gateway.sendMessage(message);
  const persisted = await OutboxEvent.updateOne(
    {
      _id: event._id,
      status: 'PROCESSING',
      lockedBy: event.lockedBy,
      lockedAt: event.lockedAt,
      sentAt: null,
    },
    {
      $set: {
        providerMessageId: result.messageId ?? null,
        sentAt: new Date(),
        deliveryOutcome: 'SENT',
      },
    },
  );
  if (!persisted.matchedCount)
    throw new OutboxHandlerError('EMAIL_DELIVERY_STATE_WRITE_FAILED', true);
  logger.info(
    {
      bookingId: String(booking._id),
      workItemId: String(event._id),
      notificationType: event.eventType,
      deliveryStatus: 'SENT',
    },
    'Booking email notification sent',
  );
}

async function persistDeliveryOutcome(
  event: Readonly<OutboxEventRecord>,
  outcome: 'SKIPPED_BOOKING_STARTED' | 'SKIPPED_INVALID_STATE',
): Promise<void> {
  const persisted = await OutboxEvent.updateOne(
    {
      _id: event._id,
      status: 'PROCESSING',
      lockedBy: event.lockedBy,
      lockedAt: event.lockedAt,
      sentAt: null,
    },
    { $set: { deliveryOutcome: outcome } },
  );
  if (!persisted.matchedCount)
    throw new OutboxHandlerError('EMAIL_DELIVERY_STATE_WRITE_FAILED', true);
}

function logReminderSkip(
  event: Readonly<OutboxEventRecord>,
  outcome: 'SKIPPED_BOOKING_STARTED' | 'SKIPPED_INVALID_STATE',
): void {
  logger.info(
    {
      bookingId: String(event.aggregateId),
      workItemId: String(event._id),
      reminderType: event.eventType,
      deliveryOutcome: outcome,
    },
    'Booking reminder suppressed',
  );
}

function buildNotificationText(input: {
  approved: boolean;
  reminderHours: 24 | 3 | null;
  recipientName?: string;
  requesterName: string;
  roomName: string;
  roomLocation: string;
  startAt: Date;
  endAt: Date;
  description: string | null;
  rejectionReason: string | null;
  includeRequester: boolean;
}): string {
  const start = DateTime.fromJSDate(input.startAt, { zone: 'utc' }).setZone(
    env.APP_TIMEZONE,
  );
  const end = DateTime.fromJSDate(input.endAt, { zone: 'utc' }).setZone(
    env.APP_TIMEZONE,
  );
  const schedule = `${start.toFormat('cccc, LLLL d, yyyy')} · ${start.toFormat('h:mm a')}–${end.toFormat('h:mm a')} (${env.APP_TIMEZONE})`;
  if (input.approved) {
    const greeting = input.recipientName
      ? `Hello ${input.recipientName},\n\n`
      : '';
    const opening = input.reminderHours
      ? `This is a reminder approximately ${input.reminderHours} hours before an upcoming approved room booking.`
      : input.includeRequester
        ? 'You have been included in an approved room booking.'
        : 'Your booking request has been approved.';
    return [
      `${greeting}${opening}`,
      '',
      `Room: ${input.roomName}`,
      `Location: ${input.roomLocation}`,
      `When: ${schedule}`,
      `Requester: ${input.requesterName}`,
      ...(input.description ? ['', `Notes: ${input.description}`] : []),
    ].join('\n');
  }
  return [
    `${input.recipientName ? `Hello ${input.recipientName},\n\n` : ''}Your booking request has been rejected.`,
    '',
    `Room: ${input.roomName}`,
    `Location: ${input.roomLocation}`,
    `Requested time: ${schedule}`,
    `Reason: ${input.rejectionReason ?? 'No reason provided.'}`,
  ].join('\n');
}

function deterministicMessageId(
  eventType: string,
  bookingId: string,
  recipientKey: string,
): string {
  const digest = createHash('sha256')
    .update(`${eventType}:${bookingId}:${recipientKey}`)
    .digest('hex');
  return `<${digest}@booking-notifications.invalid>`;
}

function encodeMimeMessage(input: OutgoingEmail & { from: string }): string {
  const from = normalizeAddress(input.from);
  const to = normalizeAddress(input.to);
  const safeSubjects = [
    'Booking Request Approved',
    'Booking Request Rejected',
    'Booking Reminder - 24 Hours',
    'Booking Reminder - 3 Hours',
  ];
  const safeSubject = safeSubjects.includes(input.subject)
    ? input.subject
    : (() => {
        throw new OutboxHandlerError('INVALID_EMAIL_SUBJECT', false);
      })();
  if (!/^<[a-f0-9]{64}@booking-notifications\.invalid>$/.test(input.messageId))
    throw new OutboxHandlerError('INVALID_EMAIL_MESSAGE_ID', false);
  const body =
    Buffer.from(input.text, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '';
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${safeSubject}`,
    `Message-ID: ${input.messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
  return Buffer.from(mime, 'utf8').toString('base64url');
}

export function decodeMimeForTesting(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

export function createMimeForTesting(
  message: OutgoingEmail,
  from: string,
): string {
  return encodeMimeMessage({ ...message, from });
}

export async function migrateOutboxRecipientIndex(): Promise<void> {
  const collection = OutboxEvent.collection;
  await OutboxEvent.init();
  const existingIndexes = await collection.indexes();
  const next = existingIndexes.find(
    (index) => index.name === 'outbox_event_recipient_idempotency',
  );
  if (!next) {
    await collection.createIndex(
      {
        eventType: 1,
        aggregateType: 1,
        aggregateId: 1,
        'payload.recipientKey': 1,
      },
      { unique: true, name: 'outbox_event_recipient_idempotency' },
    );
  }
  const old = existingIndexes.find(
    (index) => index.name === 'outbox_decision_idempotency',
  );
  if (old) await collection.dropIndex('outbox_decision_idempotency');
}

export async function projectUnprocessedHistoricalEmailEvents(): Promise<number> {
  const events = await OutboxEvent.aggregate<OutboxEventRecord>([
    {
      $match: {
        eventType: { $in: DOMAIN_EVENT_TYPES },
        aggregateType: 'BOOKING',
      },
    },
    {
      $lookup: {
        from: EmailProjection.collection.name,
        let: { sourceId: '$_id' },
        pipeline: [
          {
            $match: {
              consumer: 'EMAIL',
              $expr: { $eq: ['$sourceEventId', '$$sourceId'] },
            },
          },
          { $limit: 1 },
        ],
        as: 'emailProjection',
      },
    },
    { $match: { emailProjection: { $eq: [] } } },
    { $sort: { createdAt: 1, _id: 1 } },
    { $limit: EMAIL_PROJECTION_BATCH_SIZE },
  ]);
  for (const event of events) {
    const projector =
      event.eventType === 'BOOKING_APPROVED'
        ? createEmailApprovalProjector()
        : createEmailRejectionProjector();
    try {
      await projector(event);
    } catch (error) {
      logger.warn(
        {
          sourceEventId: String(event._id),
          bookingId: String(event.aggregateId),
          errorCode:
            error instanceof OutboxHandlerError
              ? error.errorCode
              : 'EMAIL_PROJECTION_TEMPORARY_FAILURE',
        },
        'Historical email projection will be retried',
      );
    }
  }
  return events.length;
}

export async function projectUnprocessedHistoricalReminderEvents(
  clock: () => Date = () => new Date(),
): Promise<number> {
  const events = await OutboxEvent.aggregate<OutboxEventRecord>([
    {
      $match: {
        eventType: 'BOOKING_APPROVED',
        aggregateType: 'BOOKING',
      },
    },
    {
      $lookup: {
        from: ReminderProjection.collection.name,
        let: { sourceId: '$_id' },
        pipeline: [
          {
            $match: {
              consumer: 'REMINDERS',
              $expr: { $eq: ['$sourceEventId', '$$sourceId'] },
            },
          },
          { $limit: 1 },
        ],
        as: 'reminderProjection',
      },
    },
    { $match: { reminderProjection: { $eq: [] } } },
    { $sort: { createdAt: 1, _id: 1 } },
    { $limit: REMINDER_PROJECTION_BATCH_SIZE },
  ]);
  const projector = createReminderProjector(clock);
  for (const event of events) {
    try {
      await projector(event);
    } catch (error) {
      logger.warn(
        {
          sourceEventId: String(event._id),
          bookingId: String(event.aggregateId),
          errorCode:
            error instanceof OutboxHandlerError
              ? error.errorCode
              : 'REMINDER_PROJECTION_TEMPORARY_FAILURE',
        },
        'Historical reminder projection will be retried',
      );
    }
  }
  return events.length;
}

export async function runReminderProjectionBackfill(
  signal: AbortSignal,
  clock: () => Date = () => new Date(),
): Promise<void> {
  await ReminderProjection.init();
  while (!signal.aborted) {
    let count = 0;
    try {
      count = await projectUnprocessedHistoricalReminderEvents(clock);
    } catch {
      logger.warn(
        'Historical reminder projection scan failed; it will be retried',
      );
    }
    if (count === REMINDER_PROJECTION_BATCH_SIZE) continue;
    await abortableDelay(EMAIL_PROJECTION_RETRY_INTERVAL_MS, signal);
  }
}

export async function runEmailProjectionBackfill(
  signal: AbortSignal,
): Promise<void> {
  await EmailProjection.init();
  while (!signal.aborted) {
    try {
      let count = await projectUnprocessedHistoricalEmailEvents();
      while (count === EMAIL_PROJECTION_BATCH_SIZE && !signal.aborted)
        count = await projectUnprocessedHistoricalEmailEvents();
    } catch {
      logger.warn(
        'Historical email projection scan failed; it will be retried',
      );
    }
    await abortableDelay(EMAIL_PROJECTION_RETRY_INTERVAL_MS, signal);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export function isDuplicateKey(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 11000,
  );
}

function classifyGmailError(error: unknown): OutboxHandlerError {
  const candidate =
    error && typeof error === 'object'
      ? (error as {
          code?: string | number;
          response?: {
            status?: number;
            headers?: Record<string, string | number>;
            data?: { error?: { errors?: Array<{ reason?: string }> } };
          };
        })
      : {};
  const status =
    candidate.response?.status ??
    (typeof candidate.code === 'number' ? candidate.code : undefined);
  const code =
    typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  const reason = candidate.response?.data?.error?.errors?.[0]?.reason;
  if (
    status === 429 ||
    reason === 'rateLimitExceeded' ||
    reason === 'userRateLimitExceeded'
  ) {
    const raw = candidate.response?.headers?.['retry-after'];
    const retryAfterMs = parseRetryAfter(raw);
    return new OutboxHandlerError('GMAIL_RATE_LIMITED', true, retryAfterMs);
  }
  if (status === 401)
    return new OutboxHandlerError('GMAIL_AUTHENTICATION_FAILED', false);
  if (status === 403) {
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')
      return new OutboxHandlerError(
        'GMAIL_RATE_LIMITED',
        true,
        parseRetryAfter(candidate.response?.headers?.['retry-after']),
      );
    return new OutboxHandlerError('GMAIL_PERMISSION_DENIED', false);
  }
  if (status === 400)
    return new OutboxHandlerError('GMAIL_INVALID_MESSAGE', false);
  if (status && status >= 500)
    return new OutboxHandlerError('GMAIL_SERVER_ERROR', true);
  if (
    [
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'ECONNREFUSED',
    ].includes(code)
  )
    return new OutboxHandlerError('GMAIL_NETWORK_FAILURE', true);
  return new OutboxHandlerError('GMAIL_TEMPORARY_FAILURE', true);
}

function parseRetryAfter(value: string | number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.max(0, Math.min(value * 1000, 3_600_000));
  if (typeof value !== 'string') return 0;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, 3_600_000);
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? 0
    : Math.min(Math.max(0, date - Date.now()), 3_600_000);
}
