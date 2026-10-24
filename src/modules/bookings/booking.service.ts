import { Types } from 'mongoose';
import { DateTime } from 'luxon';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';
import { Room } from '../rooms/room.model.js';
import { User } from '../users/user.model.js';
import {
  BLOCKING_BOOKING_STATUSES,
  Booking,
  type BookingGuest,
  type BookingStatus,
} from './booking.model.js';

/**
 * Shared authoritative conflict check used by both createBooking and the
 * availability endpoint.  Returns true when at least one PENDING or APPROVED
 * booking overlaps the given [startAt, endAt) interval for the room.
 * Adjacent bookings (touching but not overlapping) are NOT a conflict.
 */
export async function checkBookingConflict(
  roomId: Types.ObjectId,
  startAt: Date,
  endAt: Date,
): Promise<boolean> {
  const conflict = await Booking.exists({
    room: roomId,
    status: { $in: BLOCKING_BOOKING_STATUSES },
    startAt: { $lt: endAt },
    endAt: { $gt: startAt },
  });
  return conflict !== null;
}
import type {
  AdminBookingListQuery,
  BookingListQuery,
  CreateBookingInput,
} from './booking.schemas.js';
import {
  bookingWindow,
  parseBookingInterval,
  validateBookingDate,
  validateFutureStart,
} from './booking.time.js';

export interface BookingDto {
  id: string;
  requester: { id: string; name: string; email: string };
  room: { id: string; name: string; location: string; capacity: number };
  startAt: string;
  endAt: string;
  guests: BookingGuest[];
  description: string | null;
  status: BookingStatus;
  calendarSync: null | {
    status:
      | 'PENDING'
      | 'SYNCED'
      | 'FAILED'
      | 'CANCEL_PENDING'
      | 'CANCELLED'
      | 'CANCEL_FAILED';
    syncedAt: string | null;
  };
  createdAt: string;
  updatedAt: string;
  decision: null | {
    decidedBy: { id: string; name: string; email: string };
    decidedAt: string;
    rejectionReason: string | null;
  };
  cancellation: null | {
    cancelledBy: { id: string; name: string; email: string };
    cancelledAt: string;
  };
}

type PopulatedBooking = {
  _id: Types.ObjectId;
  requester: { _id: Types.ObjectId; name: string; email: string };
  room: {
    _id: Types.ObjectId;
    name: string;
    location: string;
    capacity: number;
  };
  startAt: Date;
  endAt: Date;
  guests: BookingGuest[];
  description: string | null;
  status: BookingStatus;
  calendarSyncStatus?:
    | 'PENDING'
    | 'SYNCED'
    | 'FAILED'
    | 'CANCEL_PENDING'
    | 'CANCELLED'
    | 'CANCEL_FAILED';
  calendarSyncedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  approvedBy: { _id: Types.ObjectId; name: string; email: string } | null;
  approvedAt: Date | null;
  rejectedBy: { _id: Types.ObjectId; name: string; email: string } | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  cancelledBy: { _id: Types.ObjectId; name: string; email: string } | null;
  cancelledAt: Date | null;
};

export function toBookingDto(booking: PopulatedBooking): BookingDto {
  return {
    id: booking._id.toString(),
    requester: {
      id: booking.requester._id.toString(),
      name: booking.requester.name,
      email: booking.requester.email,
    },
    room: {
      id: booking.room._id.toString(),
      name: booking.room.name,
      location: booking.room.location,
      capacity: booking.room.capacity,
    },
    startAt: booking.startAt.toISOString(),
    endAt: booking.endAt.toISOString(),
    guests: booking.guests.map(({ name, email }) => ({
      ...(name ? { name } : {}),
      email,
    })),
    description: booking.description ?? null,
    status: booking.status,
    calendarSync:
      booking.status === 'APPROVED' || booking.status === 'CANCELLED'
        ? {
            status: booking.calendarSyncStatus ?? 'PENDING',
            syncedAt: booking.calendarSyncedAt?.toISOString() ?? null,
          }
        : null,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    decision:
      booking.status === 'APPROVED' && booking.approvedBy && booking.approvedAt
        ? {
            decidedBy: {
              id: booking.approvedBy._id.toString(),
              name: booking.approvedBy.name,
              email: booking.approvedBy.email,
            },
            decidedAt: booking.approvedAt.toISOString(),
            rejectionReason: null,
          }
        : booking.status === 'REJECTED' &&
            booking.rejectedBy &&
            booking.rejectedAt
          ? {
              decidedBy: {
                id: booking.rejectedBy._id.toString(),
                name: booking.rejectedBy.name,
                email: booking.rejectedBy.email,
              },
              decidedAt: booking.rejectedAt.toISOString(),
              rejectionReason: booking.rejectionReason ?? null,
            }
          : null,
    cancellation:
      booking.status === 'CANCELLED' &&
      booking.cancelledBy &&
      booking.cancelledAt
        ? {
            cancelledBy: {
              id: booking.cancelledBy._id.toString(),
              name: booking.cancelledBy.name,
              email: booking.cancelledBy.email,
            },
            cancelledAt: booking.cancelledAt.toISOString(),
          }
        : null,
  };
}

export async function createBooking(
  requesterId: string,
  requesterEmail: string,
  input: CreateBookingInput,
  now: Date = new Date(),
): Promise<BookingDto> {
  const room = await Room.findById(input.roomId);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room was not found');
  if (room.status !== 'ACTIVE')
    throw new AppError(
      409,
      'ROOM_INACTIVE',
      'Room is not available for new bookings',
    );

  validateBookingDate(input.date, now, env.APP_TIMEZONE);
  const interval = parseBookingInterval(
    input.date,
    input.startTime,
    input.endTime,
    env.APP_TIMEZONE,
  );
  validateFutureStart(interval.startAt, now);

  const normalizedRequesterEmail = requesterEmail.trim().toLowerCase();
  const uniqueGuests: BookingGuest[] = [];
  const emails = new Set<string>();
  for (const guest of input.guests) {
    const email = guest.email.trim().toLowerCase();
    if (email === normalizedRequesterEmail) continue;
    if (emails.has(email)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request data', {
        guests: ['Guest email addresses must be unique'],
      });
    }
    emails.add(email);
    uniqueGuests.push({
      ...(guest.name ? { name: guest.name.trim() } : {}),
      email,
    });
  }
  if (uniqueGuests.length + 1 > room.capacity) {
    throw new AppError(
      400,
      'ROOM_CAPACITY_EXCEEDED',
      'The requester and guests exceed room capacity',
    );
  }

  const hasConflict = await checkBookingConflict(
    room._id,
    interval.startAt,
    interval.endAt,
  );
  if (hasConflict)
    throw new AppError(
      409,
      'BOOKING_CONFLICT',
      'The room has a booking request during that time',
    );

  const requester = await User.findById(requesterId).select(
    '_id name email status',
  );
  if (!requester || requester.status !== 'ACTIVE') {
    throw new AppError(
      401,
      'AUTHENTICATION_REQUIRED',
      'Authentication is required',
    );
  }

  const booking = await Booking.create({
    requester: requester._id,
    room: room._id,
    ...interval,
    guests: uniqueGuests,
    description: input.description ?? null,
    status: 'PENDING',
  });
  const populated = await Booking.findById(booking._id)
    .populate('requester', 'name email')
    .populate('room', 'name location capacity')
    .populate('approvedBy', 'name email')
    .populate('rejectedBy', 'name email')
    .populate('cancelledBy', 'name email');
  if (!populated)
    throw new AppError(
      500,
      'INTERNAL_SERVER_ERROR',
      'An unexpected error occurred',
    );
  return toBookingDto(populated as unknown as PopulatedBooking);
}

export async function listUserBookings(
  requesterId: string,
  query: BookingListQuery,
) {
  const filter = { requester: new Types.ObjectId(requesterId) };
  const sort: Record<string, 1 | -1> =
    query.sort === 'UPCOMING'
      ? { startAt: 1, _id: 1 }
      : query.sort === 'OLDEST'
        ? { createdAt: 1, _id: 1 }
        : { createdAt: -1, _id: -1 };
  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .sort(sort)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .populate('requester', 'name email')
      .populate('room', 'name location capacity')
      .populate('approvedBy', 'name email')
      .populate('rejectedBy', 'name email')
      .populate('cancelledBy', 'name email'),
    Booking.countDocuments(filter),
  ]);
  return {
    bookings: bookings.map((booking) =>
      toBookingDto(booking as unknown as PopulatedBooking),
    ),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export async function getUserBooking(
  bookingId: string,
  requesterId: string,
): Promise<BookingDto> {
  const booking = await Booking.findOne({
    _id: bookingId,
    requester: requesterId,
  })
    .populate('requester', 'name email')
    .populate('room', 'name location capacity')
    .populate('approvedBy', 'name email')
    .populate('rejectedBy', 'name email')
    .populate('cancelledBy', 'name email');
  if (!booking) throw bookingNotFound();
  return toBookingDto(booking as unknown as PopulatedBooking);
}

export async function listAdminBookings(query: AdminBookingListQuery) {
  const filter = query.status ? { status: query.status } : {};
  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .sort({ startAt: 1, _id: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .populate('requester', 'name email')
      .populate('room', 'name location capacity')
      .populate('approvedBy', 'name email')
      .populate('rejectedBy', 'name email')
      .populate('cancelledBy', 'name email'),
    Booking.countDocuments(filter),
  ]);
  return {
    bookings: bookings.map((booking) =>
      toBookingDto(booking as unknown as PopulatedBooking),
    ),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export async function getAdminBooking(bookingId: string): Promise<BookingDto> {
  const booking = await Booking.findById(bookingId)
    .populate('requester', 'name email')
    .populate('room', 'name location capacity')
    .populate('approvedBy', 'name email')
    .populate('rejectedBy', 'name email')
    .populate('cancelledBy', 'name email');
  if (!booking) throw bookingNotFound();
  return toBookingDto(booking as unknown as PopulatedBooking);
}

export async function listBookingSchedule(query: {
  date?: string;
  startDate?: string;
  endDate?: string;
  roomId?: string;
}): Promise<Array<{ room: string; startAt: string; endAt: string }>> {
  const timezone = env.APP_TIMEZONE;
  const rangeStart = query.date ?? query.startDate!;
  const rangeEnd = query.date ?? query.endDate!;
  const start = DateTime.fromFormat(rangeStart, 'yyyy-MM-dd', {
    zone: timezone,
  });
  const end = DateTime.fromFormat(rangeEnd, 'yyyy-MM-dd', { zone: timezone });
  if (
    !start.isValid ||
    !end.isValid ||
    start.toISODate() !== rangeStart ||
    end.toISODate() !== rangeEnd
  )
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid schedule range');
  const now = new Date();
  const window = bookingWindow(now, timezone);
  if (
    rangeStart < window.today ||
    rangeEnd > window.maximumDate ||
    rangeStart > rangeEnd
  )
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Schedule range is outside the booking window',
    );
  if (end.diff(start, 'days').days > 31)
    throw new AppError(400, 'VALIDATION_ERROR', 'Schedule range is too large');
  const startAt = start.startOf('day').toUTC().toJSDate();
  const endAt = end.plus({ days: 1 }).startOf('day').toUTC().toJSDate();
  const bookings = await Booking.find({
    status: 'APPROVED',
    startAt: { $lt: endAt },
    endAt: { $gt: startAt },
    ...(query.roomId ? { room: query.roomId } : {}),
  })
    .select('_id room startAt endAt')
    .populate('room', 'name')
    .sort({ startAt: 1, _id: 1 })
    .lean();
  return bookings.map((booking) => ({
    room: (booking.room as unknown as { name: string }).name,
    startAt: booking.startAt.toISOString(),
    endAt: booking.endAt.toISOString(),
  }));
}

function bookingNotFound(): AppError {
  return new AppError(404, 'BOOKING_NOT_FOUND', 'Booking was not found');
}
