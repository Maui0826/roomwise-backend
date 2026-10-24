import type { RequestHandler } from 'express';
import { logger } from '../../config/logger.js';
import type {
  AdminRoomListQuery,
  AvailabilityQuery,
  CreateRoomInput,
  UpdateRoomInput,
  UpdateRoomStatusInput,
} from './room.schemas.js';
import {
  checkRoomAvailability,
  createRoom,
  getRoom,
  listActiveRooms,
  listAdminRooms,
  updateRoom,
  updateRoomStatus,
} from './room.service.js';

export const create: RequestHandler = async (req, res) => {
  const room = await createRoom(req.body as CreateRoomInput);
  logger.info(
    {
      action: 'room.created',
      adminUserId: req.auth?.userId.toString(),
      roomId: room.id,
    },
    'Admin room action',
  );
  res.status(201).json({ success: true, data: { room } });
};

export const listActive: RequestHandler = async (_req, res) => {
  res
    .status(200)
    .json({ success: true, data: { rooms: await listActiveRooms() } });
};

export const listAdmin: RequestHandler = async (_req, res) => {
  const query = res.locals.validatedQuery as AdminRoomListQuery;
  res.status(200).json({
    success: true,
    data: { rooms: await listAdminRooms(query.status) },
  });
};

export const detail: RequestHandler = async (req, res) => {
  const room = await getRoom(
    String(req.params.roomId),
    req.auth?.role === 'ADMIN',
  );
  res.status(200).json({ success: true, data: { room } });
};

export const update: RequestHandler = async (req, res) => {
  const room = await updateRoom(
    String(req.params.roomId),
    req.body as UpdateRoomInput,
  );
  logger.info(
    {
      action: 'room.updated',
      adminUserId: req.auth?.userId.toString(),
      roomId: room.id,
    },
    'Admin room action',
  );
  res.status(200).json({ success: true, data: { room } });
};

export const updateStatus: RequestHandler = async (req, res) => {
  const { status } = req.body as UpdateRoomStatusInput;
  const room = await updateRoomStatus(String(req.params.roomId), status);
  logger.info(
    {
      action: status === 'ACTIVE' ? 'room.activated' : 'room.deactivated',
      adminUserId: req.auth?.userId.toString(),
      roomId: room.id,
    },
    'Admin room action',
  );
  res.status(200).json({ success: true, data: { room } });
};

export const checkAvailability: RequestHandler = async (req, res) => {
  const query = res.locals.validatedQuery as AvailabilityQuery;
  const result = await checkRoomAvailability(String(req.params.roomId), query);
  res.status(200).json({ success: true, data: result });
};
