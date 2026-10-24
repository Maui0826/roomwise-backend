import mongoose, { Types } from 'mongoose';
import { AppError } from '../../shared/errors/app-error.js';
import { Room } from '../rooms/room.model.js';
import { Booking } from './booking.model.js';
import { getAdminBooking, type BookingDto } from './booking.service.js';
import { createBookingDecisionEvent } from '../outbox/outbox.service.js';
import { createCalendarDeletionEvent } from '../outbox/outbox.service.js';
import { env } from '../../config/env.js';

export type Clock = () => Date;
const systemClock: Clock = () => new Date();
const TRANSACTION_RETRY_TIMEOUT_MS = 10_000;

export async function approveBooking(
  bookingId: string,
  adminId: string,
  clock: Clock = systemClock,
): Promise<BookingDto> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(
      async () => {
        const booking = await Booking.findById(bookingId).session(session);
        if (!booking) throw bookingNotFound();
        if (booking.status !== 'PENDING') throw alreadyDecided();

        // This durable Room write serializes approval transactions for this Room across all processes.
        // The write predicate also revalidates that the room is active at the serialization point.
        const room = await Room.findOneAndUpdate(
          { _id: booking.room, status: 'ACTIVE' },
          { $inc: { bookingApprovalVersion: 1 } },
          { session, returnDocument: 'after' },
        ).select('_id status');
        if (!room) {
          const exists = await Room.exists({ _id: booking.room }).session(
            session,
          );
          if (!exists)
            throw new AppError(404, 'ROOM_NOT_FOUND', 'Room was not found');
          throw new AppError(
            409,
            'ROOM_INACTIVE',
            'Room is not available for approval',
          );
        }

        const approvedAt = clock();
        if (booking.startAt.getTime() <= approvedAt.getTime()) {
          throw new AppError(
            409,
            'BOOKING_START_PASSED',
            'Booking start time has passed',
          );
        }

        const conflict = await Booking.findOne({
          _id: { $ne: booking._id },
          room: booking.room,
          status: 'APPROVED',
          startAt: { $lt: booking.endAt },
          endAt: { $gt: booking.startAt },
        })
          .select('_id')
          .session(session)
          .lean();
        if (conflict) {
          throw new AppError(
            409,
            'BOOKING_CONFLICT',
            'An approved booking overlaps this time',
          );
        }

        booking.status = 'APPROVED';
        booking.approvedBy = new Types.ObjectId(adminId);
        booking.approvedAt = approvedAt;
        booking.rejectedBy = null;
        booking.rejectedAt = null;
        booking.rejectionReason = null;
        await booking.save({ session });
        await createBookingDecisionEvent(
          'BOOKING_APPROVED',
          booking.id,
          approvedAt,
          session,
        );
      },
      {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 5_000,
        timeoutMS: TRANSACTION_RETRY_TIMEOUT_MS,
      },
    );
  } finally {
    await session.endSession();
  }
  return getAdminBooking(bookingId);
}

export async function rejectBooking(
  bookingId: string,
  adminId: string,
  reason: string,
  clock: Clock = systemClock,
): Promise<BookingDto> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(
      async () => {
        const booking = await Booking.findById(bookingId).session(session);
        if (!booking) throw bookingNotFound();
        if (booking.status !== 'PENDING') throw alreadyDecided();

        const rejectedAt = clock();
        const rejected = await Booking.findOneAndUpdate(
          { _id: booking._id, status: 'PENDING' },
          {
            $set: {
              status: 'REJECTED',
              rejectedBy: new Types.ObjectId(adminId),
              rejectedAt,
              rejectionReason: reason.trim(),
              approvedBy: null,
              approvedAt: null,
            },
          },
          { session, returnDocument: 'after', runValidators: true },
        );
        if (!rejected) throw alreadyDecided();
        await createBookingDecisionEvent(
          'BOOKING_REJECTED',
          booking.id,
          rejectedAt,
          session,
        );
      },
      {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 5_000,
        timeoutMS: TRANSACTION_RETRY_TIMEOUT_MS,
      },
    );
  } finally {
    await session.endSession();
  }
  return getAdminBooking(bookingId);
}

export async function cancelBooking(
  bookingId: string,
  approverId: string,
  clock: Clock = systemClock,
): Promise<BookingDto> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(
      async () => {
        const booking = await Booking.findById(bookingId).session(session);
        if (!booking) throw bookingNotFound();
        if (booking.status === 'CANCELLED') return;
        if (booking.status !== 'APPROVED')
          throw new AppError(
            409,
            'BOOKING_NOT_CANCELLABLE',
            'Only approved bookings can be cancelled',
          );

        const room = await Room.findOneAndUpdate(
          { _id: booking.room },
          { $inc: { bookingApprovalVersion: 1 } },
          { session, returnDocument: 'after' },
        ).select('_id');
        if (!room)
          throw new AppError(404, 'ROOM_NOT_FOUND', 'Room was not found');

        const cancelledAt = clock();
        const cancelled = await Booking.findOneAndUpdate(
          { _id: booking._id, status: 'APPROVED' },
          {
            $set: {
              status: 'CANCELLED',
              cancelledBy: new Types.ObjectId(approverId),
              cancelledAt,
              calendarSyncStatus: 'CANCEL_PENDING',
              calendarSyncedAt: null,
            },
          },
          { session, returnDocument: 'after', runValidators: true },
        );
        if (!cancelled)
          throw new AppError(
            409,
            'BOOKING_NOT_CANCELLABLE',
            'Only approved bookings can be cancelled',
          );
        await createCalendarDeletionEvent(
          String(booking._id),
          cancelledAt,
          env.OUTBOX_MAX_ATTEMPTS,
          session,
        );
      },
      {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 5_000,
        timeoutMS: TRANSACTION_RETRY_TIMEOUT_MS,
      },
    );
  } finally {
    await session.endSession();
  }
  return getAdminBooking(bookingId);
}

function bookingNotFound(): AppError {
  return new AppError(404, 'BOOKING_NOT_FOUND', 'Booking was not found');
}

function alreadyDecided(): AppError {
  return new AppError(
    409,
    'BOOKING_ALREADY_DECIDED',
    'Booking is no longer pending',
  );
}
