import { Router } from 'express';
import { requireAuth } from '../../middleware/authentication.js';
import { requireRole } from '../../middleware/authorization.js';
import { requireCsrf, validateRequestOrigin } from '../../middleware/csrf.js';
import { validateBody } from '../../middleware/validate-body.js';
import {
  validateParams,
  validateQuery,
} from '../../middleware/validate-route.js';
import {
  adminBookingListQuerySchema,
  bookingScheduleQuerySchema,
  approveBookingBodySchema,
  bookingIdParamsSchema,
  bookingListQuerySchema,
  createBookingSchema,
  rejectBookingBodySchema,
} from './booking.schemas.js';
import {
  approve,
  create,
  detailAdmin,
  detailMine,
  listAdmin,
  listMine,
  reject,
  cancel,
  schedule,
} from './booking.controller.js';
import { bookingCreateRateLimit } from './booking.rate-limit.js';

export const bookingsRouter = Router();
export const approverBookingsRouter = Router();

bookingsRouter.post(
  '/',
  requireAuth,
  bookingCreateRateLimit,
  validateRequestOrigin,
  requireCsrf,
  validateBody(createBookingSchema),
  create,
);
bookingsRouter.get(
  '/schedule',
  requireAuth,
  validateQuery(bookingScheduleQuerySchema),
  schedule,
);
bookingsRouter.get(
  '/',
  requireAuth,
  validateQuery(bookingListQuerySchema),
  listMine,
);
bookingsRouter.get(
  '/:bookingId',
  requireAuth,
  validateParams(bookingIdParamsSchema),
  detailMine,
);

approverBookingsRouter.get(
  '/',
  requireAuth,
  requireRole('APPROVER'),
  validateQuery(adminBookingListQuerySchema),
  listAdmin,
);
approverBookingsRouter.get(
  '/:bookingId',
  requireAuth,
  requireRole('APPROVER'),
  validateParams(bookingIdParamsSchema),
  detailAdmin,
);

approverBookingsRouter.post(
  '/:bookingId/approve',
  requireAuth,
  requireRole('APPROVER'),
  validateRequestOrigin,
  requireCsrf,
  validateParams(bookingIdParamsSchema),
  validateBody(approveBookingBodySchema),
  approve,
);
approverBookingsRouter.post(
  '/:bookingId/reject',
  requireAuth,
  requireRole('APPROVER'),
  validateRequestOrigin,
  requireCsrf,
  validateParams(bookingIdParamsSchema),
  validateBody(rejectBookingBodySchema),
  reject,
);
approverBookingsRouter.post(
  '/:bookingId/cancel',
  requireAuth,
  requireRole('APPROVER'),
  validateRequestOrigin,
  requireCsrf,
  validateParams(bookingIdParamsSchema),
  validateBody(approveBookingBodySchema),
  cancel,
);
