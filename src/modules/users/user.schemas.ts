import { z } from 'zod';
export const userIdParamsSchema = z
  .object({ userId: z.string().regex(/^[a-f\d]{24}$/i) })
  .strict();
export const adminUserListQuerySchema = z
  .object({
    status: z
      .enum(['ACTIVE', 'SUSPENDED', 'BANNED', 'INACTIVE', 'ALL'])
      .default('ALL'),
  })
  .strict();
export const updateUserStatusSchema = z
  .object({ status: z.enum(['ACTIVE', 'BANNED', 'INACTIVE']) })
  .strict();
export const updateUserProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(254),
    role: z.enum(['USER', 'APPROVER', 'ADMIN']),
  })
  .strict();
export const suspendUserSchema = z
  .object({ days: z.number().int().min(1).max(365) })
  .strict();
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;
