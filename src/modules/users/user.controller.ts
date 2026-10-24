import type { RequestHandler } from 'express';
import {
  listAdminUsers,
  getAdminUser,
  updateAdminUserStatus,
  updateAdminUserProfile,
  suspendAdminUser,
} from './user.service.js';
export const list: RequestHandler = async (_req, res) => {
  res.json({
    success: true,
    data: { users: await listAdminUsers(res.locals.validatedQuery.status) },
  });
};
export const detail: RequestHandler = async (req, res) => {
  res.json({
    success: true,
    data: { user: await getAdminUser(String(req.params.userId)) },
  });
};
export const updateStatus: RequestHandler = async (req, res) => {
  res.json({
    success: true,
    data: {
      user: await updateAdminUserStatus(
        String(req.params.userId),
        req.auth!.userId.toString(),
        req.body.status,
      ),
    },
  });
};
export const updateProfile: RequestHandler = async (req, res) => {
  res.json({
    success: true,
    data: {
      user: await updateAdminUserProfile(
        String(req.params.userId),
        req.auth!.userId.toString(),
        req.body,
      ),
    },
  });
};
export const suspend: RequestHandler = async (req, res) => {
  res.json({
    success: true,
    data: {
      user: await suspendAdminUser(
        String(req.params.userId),
        req.auth!.userId.toString(),
        req.body.days,
      ),
    },
  });
};
