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
  adminUserListQuerySchema,
  updateUserStatusSchema,
  updateUserProfileSchema,
  suspendUserSchema,
  userIdParamsSchema,
} from './user.schemas.js';
import {
  list,
  detail,
  updateStatus,
  updateProfile,
  suspend,
} from './user.controller.js';
export const adminUsersRouter = Router();
adminUsersRouter.get(
  '/',
  requireAuth,
  requireRole('ADMIN'),
  validateQuery(adminUserListQuerySchema),
  list,
);
adminUsersRouter.get(
  '/:userId',
  requireAuth,
  requireRole('ADMIN'),
  validateParams(userIdParamsSchema),
  detail,
);
adminUsersRouter.patch(
  '/:userId/status',
  requireAuth,
  requireRole('ADMIN'),
  validateRequestOrigin,
  requireCsrf,
  validateParams(userIdParamsSchema),
  validateBody(updateUserStatusSchema),
  updateStatus,
);
adminUsersRouter.patch(
  '/:userId',
  requireAuth,
  requireRole('ADMIN'),
  validateRequestOrigin,
  requireCsrf,
  validateParams(userIdParamsSchema),
  validateBody(updateUserProfileSchema),
  updateProfile,
);
adminUsersRouter.post(
  '/:userId/suspend',
  requireAuth,
  requireRole('ADMIN'),
  validateRequestOrigin,
  requireCsrf,
  validateParams(userIdParamsSchema),
  validateBody(suspendUserSchema),
  suspend,
);
