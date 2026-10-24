import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  approveBooking,
  cancelBooking,
  rejectBooking,
} from './booking.decision.service.js';
import type {
  AdminBookingListQuery,
  BookingListQuery,
  CreateBookingInput,
  RejectBookingInput,
} from './booking.schemas.js';
import {
  createBooking,
  getAdminBooking,
  getUserBooking,
  listAdminBookings,
  listUserBookings,
  listBookingSchedule,
} from './booking.service.js';

export const create: RequestHandler = async (req, res) => {
  const auth = req.auth!;
  const booking = await createBooking(
    auth.userId.toString(),
    auth.email,
    req.body as CreateBookingInput,
  );
  logger.info(
    {
      action: 'booking.requested',
      bookingId: booking.id,
      requesterUserId: auth.userId.toString(),
      roomId: booking.room.id,
    },
    'Booking request created',
  );
  res.status(201).json({ success: true, data: { booking } });
};

export const listMine: RequestHandler = async (req, res) => {
  const query = res.locals.validatedQuery as BookingListQuery;
  res.status(200).json({
    success: true,
    data: await listUserBookings(req.auth!.userId.toString(), query),
  });
};

export const detailMine: RequestHandler = async (req, res) => {
  const booking = await getUserBooking(
    String(req.params.bookingId),
    req.auth!.userId.toString(),
  );
  res.status(200).json({ success: true, data: { booking } });
};

export const schedule: RequestHandler = async (_req, res) => {
  res.status(200).json({
    success: true,
    data: {
      events: await listBookingSchedule(res.locals.validatedQuery),
      timezone: env.APP_TIMEZONE,
    },
  });
};

export const listAdmin: RequestHandler = async (_req, res) => {
  const query = res.locals.validatedQuery as AdminBookingListQuery;
  res.status(200).json({ success: true, data: await listAdminBookings(query) });
};

export const detailAdmin: RequestHandler = async (req, res) => {
  const booking = await getAdminBooking(String(req.params.bookingId));
  res.status(200).json({ success: true, data: { booking } });
};

export const approve: RequestHandler = async (req, res) => {
  const booking = await approveBooking(
    String(req.params.bookingId),
    req.auth!.userId.toString(),
  );
  logger.info(
    {
      action: 'booking.approved',
      bookingId: booking.id,
      adminUserId: req.auth!.userId.toString(),
      roomId: booking.room.id,
    },
    'Admin booking decision',
  );
  res.status(200).json({ success: true, data: { booking } });
};

export const reject: RequestHandler = async (req, res) => {
  const { reason } = req.body as RejectBookingInput;
  const booking = await rejectBooking(
    String(req.params.bookingId),
    req.auth!.userId.toString(),
    reason,
  );
  logger.info(
    {
      action: 'booking.rejected',
      bookingId: booking.id,
      adminUserId: req.auth!.userId.toString(),
      roomId: booking.room.id,
    },
    'Admin booking decision',
  );
  res.status(200).json({ success: true, data: { booking } });
};

export const cancel: RequestHandler = async (req, res) => {
  const booking = await cancelBooking(
    String(req.params.bookingId),
    req.auth!.userId.toString(),
  );
  logger.info(
    {
      action: 'booking.cancelled',
      bookingId: booking.id,
      approverUserId: req.auth!.userId.toString(),
      roomId: booking.room.id,
    },
    'Booking cancelled by Approver',
  );
  res.status(200).json({ success: true, data: { booking } });
};
