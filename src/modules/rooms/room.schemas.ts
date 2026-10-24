import { z } from 'zod';

const roomName = z.string().trim().min(1).max(120);
const roomLocation = z.string().trim().min(1).max(200);
const roomDescription = z
  .union([
    z
      .string()
      .trim()
      .max(2000)
      .transform((value) => value || null),
    z.null(),
  ])
  .optional();
const roomCapacity = z.number().int().min(1).max(100_000);

export const createRoomSchema = z
  .object({
    name: roomName,
    description: roomDescription,
    location: roomLocation,
    capacity: roomCapacity,
  })
  .strict();

export const updateRoomSchema = z
  .object({
    name: roomName.optional(),
    description: roomDescription,
    location: roomLocation.optional(),
    capacity: roomCapacity.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one editable field is required',
  );

export const updateRoomStatusSchema = z
  .object({ status: z.enum(['ACTIVE', 'INACTIVE']) })
  .strict();

export const roomIdParamsSchema = z
  .object({ roomId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid room ID') })
  .strict();

export const adminRoomListQuerySchema = z
  .object({ status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ALL') })
  .strict();

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const localTime = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm');

export const availabilityQuerySchema = z
  .object({
    date: localDate,
    startTime: localTime,
    endTime: localTime,
  })
  .strict();

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;
export type UpdateRoomStatusInput = z.infer<typeof updateRoomStatusSchema>;
export type AdminRoomListQuery = z.infer<typeof adminRoomListQuerySchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
