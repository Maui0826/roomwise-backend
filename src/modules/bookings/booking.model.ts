import { Schema, model, Types } from 'mongoose';

export const BOOKING_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const BLOCKING_BOOKING_STATUSES = ['PENDING', 'APPROVED'] as const;

export interface BookingGuest {
  name?: string;
  email: string;
}

export const CALENDAR_SYNC_STATUSES = [
  'PENDING',
  'SYNCED',
  'FAILED',
  'CANCEL_PENDING',
  'CANCELLED',
  'CANCEL_FAILED',
] as const;
export type CalendarSyncStatus = (typeof CALENDAR_SYNC_STATUSES)[number];

export interface BookingRecord {
  requester: Types.ObjectId;
  room: Types.ObjectId;
  startAt: Date;
  endAt: Date;
  guests: BookingGuest[];
  description: string | null;
  status: BookingStatus;
  approvedBy: Types.ObjectId | null;
  approvedAt: Date | null;
  rejectedBy: Types.ObjectId | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  cancelledBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  calendarEventId: string | null;
  calendarSyncStatus: CalendarSyncStatus;
  calendarSyncedAt: Date | null;
  calendarLastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const guestSchema = new Schema<BookingGuest>(
  {
    name: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 100,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
  },
  { _id: false, strict: 'throw' },
);

const bookingSchema = new Schema<BookingRecord>(
  {
    requester: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    room: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    guests: { type: [guestSchema], required: true, default: [] },
    description: {
      type: String,
      default: null,
      trim: true,
      maxlength: 2000,
      set(value: string | null | undefined) {
        if (typeof value !== 'string') return value;
        return value.trim() || null;
      },
    },
    status: {
      type: String,
      enum: BOOKING_STATUSES,
      required: true,
      default: 'PENDING',
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    calendarEventId: {
      type: String,
      default: null,
      select: false,
      maxlength: 128,
    },
    calendarSyncStatus: {
      type: String,
      enum: CALENDAR_SYNC_STATUSES,
      default: 'PENDING',
    },
    calendarSyncedAt: { type: Date, default: null },
    calendarLastError: {
      type: String,
      default: null,
      select: false,
      maxlength: 80,
    },
    rejectionReason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 500,
    },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw' },
);

// Supports requester history sorted by startAt and stable _id tie-breaking.
bookingSchema.index({ requester: 1, startAt: -1, _id: -1 });
// Supports room/status conflict probes constrained by startAt; endAt is a residual range predicate.
bookingSchema.index({ room: 1, status: 1, startAt: 1, endAt: 1 });

export const Booking = model<BookingRecord>('Booking', bookingSchema);
