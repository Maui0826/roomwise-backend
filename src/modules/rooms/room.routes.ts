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
  adminRoomListQuerySchema,
  availabilityQuerySchema,
  createRoomSchema,
  roomIdParamsSchema,
  updateRoomSchema,
  updateRoomStatusSchema,
} from './room.schemas.js';
import {
  checkAvailability,
  create,
  detail,
  listActive,
  listAdmin,
  update,
  updateStatus,
} from './room.controller.js';

export const roomsRouter = Router();
export const adminRoomsRouter = Router();

roomsRouter.get('/', requireAuth, listActive);
roomsRouter.get(
  '/:roomId',
  requireAuth,
  validateParams(roomIdParamsSchema),
  detail,
);
roomsRouter.get(
  '/:roomId/availability',
  requireAuth,
  validateParams(roomIdParamsSchema),
  validateQuery(availabilityQuerySchema),
  checkAvailability,
);

const adminMutation = [
  requireAuth,
  requireRole('ADMIN'),
  validateRequestOrigin,
  requireCsrf,
];

roomsRouter.post('/', ...adminMutation, validateBody(createRoomSchema), create);
roomsRouter.patch(
  '/:roomId',
  ...adminMutation,
  validateParams(roomIdParamsSchema),
  validateBody(updateRoomSchema),
  update,
);
roomsRouter.patch(
  '/:roomId/status',
  ...adminMutation,
  validateParams(roomIdParamsSchema),
  validateBody(updateRoomStatusSchema),
  updateStatus,
);

adminRoomsRouter.get(
  '/',
  requireAuth,
  requireRole('ADMIN'),
  validateQuery(adminRoomListQuerySchema),
  listAdmin,
);
