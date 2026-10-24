import { Schema, model, Types } from 'mongoose';

export const OUTBOX_EVENT_TYPES = [
  'BOOKING_APPROVED',
  'BOOKING_REJECTED',
  'CALENDAR_BOOKING_CREATE',
  'CALENDAR_BOOKING_DELETE',
  'EMAIL_BOOKING_APPROVED',
  'EMAIL_BOOKING_REJECTED',
  'EMAIL_BOOKING_REMINDER_24H',
  'EMAIL_BOOKING_REMINDER_3H',
] as const;
export type BookingOutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
export type BookingDecisionEventType = 'BOOKING_APPROVED' | 'BOOKING_REJECTED';
export const OUTBOX_STATUSES = [
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
export type EmailDeliveryOutcome =
  'SENT' | 'SKIPPED_BOOKING_STARTED' | 'SKIPPED_INVALID_STATE';

export interface OutboxPayload {
  bookingId: string;
  occurredAt: Date;
  sourceEventId?: string;
  recipientEmail?: string;
  recipientKey?: string;
  recipientRole?: 'REQUESTER' | 'GUEST';
}

export interface OutboxEventRecord {
  _id: Types.ObjectId;
  eventType: string;
  aggregateType: string;
  aggregateId: Types.ObjectId;
  payload: OutboxPayload;
  status: OutboxStatus;
  availableAt: Date;
  attemptCount: number;
  maxAttempts: number;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  processedAt: Date | null;
  providerMessageId: string | null;
  sentAt: Date | null;
  deliveryOutcome: EmailDeliveryOutcome | null;
  createdAt: Date;
  updatedAt: Date;
}

const payloadSchema = new Schema<OutboxPayload>(
  {
    bookingId: { type: String, required: true, maxlength: 24 },
    occurredAt: { type: Date, required: true },
    sourceEventId: { type: String, maxlength: 24 },
    recipientEmail: {
      type: String,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    recipientKey: { type: String, match: /^[a-f0-9]{64}$/, maxlength: 64 },
    recipientRole: { type: String, enum: ['REQUESTER', 'GUEST'] },
  },
  { _id: false, strict: 'throw' },
);

const outboxEventSchema = new Schema<OutboxEventRecord>(
  {
    eventType: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 64,
    },
    aggregateType: { type: String, required: true, enum: ['BOOKING'] },
    aggregateId: { type: Schema.Types.ObjectId, required: true },
    payload: { type: payloadSchema, required: true },
    status: {
      type: String,
      required: true,
      enum: OUTBOX_STATUSES,
      default: 'PENDING',
    },
    availableAt: { type: Date, required: true, default: Date.now },
    attemptCount: { type: Number, required: true, min: 0, default: 0 },
    maxAttempts: { type: Number, required: true, min: 1, max: 20, default: 8 },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: String, default: null, maxlength: 100 },
    lastError: { type: String, default: null, maxlength: 80 },
    processedAt: { type: Date, default: null },
    providerMessageId: {
      type: String,
      default: null,
      maxlength: 200,
    },
    sentAt: { type: Date, default: null },
    deliveryOutcome: {
      type: String,
      enum: ['SENT', 'SKIPPED_BOOKING_STARTED', 'SKIPPED_INVALID_STATE'],
      default: null,
    },
  },
  { timestamps: true, strict: 'throw' },
);

// Recipient-aware uniqueness replaces the Phase 6 singleton index. Non-recipient events
// still have a missing recipientKey and remain unique per event type and Booking.
outboxEventSchema.index(
  { eventType: 1, aggregateType: 1, aggregateId: 1, 'payload.recipientKey': 1 },
  { unique: true, name: 'outbox_event_recipient_idempotency' },
);
// Supports eligible pending-event polling in created order.
outboxEventSchema.index(
  { status: 1, availableAt: 1, createdAt: 1 },
  { name: 'outbox_pending_claim' },
);
// Supports reclaiming events whose processing lease expired.
outboxEventSchema.index(
  { status: 1, lockedAt: 1 },
  { name: 'outbox_expired_lease' },
);

export const OutboxEvent = model<OutboxEventRecord>(
  'OutboxEvent',
  outboxEventSchema,
);
