import { DateTime } from 'luxon';
import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ObjectId');
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => {
    const parsed = DateTime.fromFormat(value, 'yyyy-MM-dd', {
      zone: 'UTC',
      locale: 'en-US',
    });
    return parsed.isValid && parsed.toISODate() === value;
  }, 'Use a valid calendar date');
const localTime = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm');
const guestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((email) => email.toLowerCase()),
  })
  .strict();

export const MAX_BOOKING_GUESTS = 100;

export const createBookingSchema = z
  .object({
    roomId: objectId,
    date: localDate,
    startTime: localTime,
    endTime: localTime,
    guests: z.array(guestSchema).max(MAX_BOOKING_GUESTS).default([]),
    description: z
      .string()
      .trim()
      .max(2000)
      .transform((value) => value || null)
      .optional(),
  })
  .strict();

export const bookingIdParamsSchema = z.object({ bookingId: objectId }).strict();
export const approveBookingBodySchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z.object({}).strict(),
);
export const rejectBookingBodySchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
export const bookingListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(['UPCOMING', 'NEWEST', 'OLDEST']).default('NEWEST'),
  })
  .strict();
export const bookingScheduleQuerySchema = z
  .object({
    date: localDate.optional(),
    startDate: localDate.optional(),
    endDate: localDate.optional(),
    roomId: objectId.optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(value.date) !== Boolean(value.startDate || value.endDate),
    { message: 'Provide date or both startDate and endDate' },
  )
  .refine(
    (value) =>
      !value.startDate || !value.endDate || value.startDate <= value.endDate,
    { message: 'Schedule range is invalid' },
  );
export const adminBookingListQuerySchema = bookingListQuerySchema.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type BookingListQuery = z.infer<typeof bookingListQuerySchema>;
export type AdminBookingListQuery = z.infer<typeof adminBookingListQuerySchema>;
export type RejectBookingInput = z.infer<typeof rejectBookingBodySchema>;
