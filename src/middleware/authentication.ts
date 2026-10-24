import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors/app-error.js';
import { digestToken } from '../shared/utils/crypto.js';
import { readSessionToken } from '../modules/auth/session-token.js';
import { Session } from '../modules/auth/session.model.js';
import { User } from '../modules/users/user.model.js';

async function loadAuth(token: string): Promise<Express.Request['auth']> {
  const session = await Session.findOne({
    tokenDigest: digestToken(token),
    expiresAt: { $gt: new Date() },
  }).select('_id userId expiresAt');
  if (!session) return undefined;

  let user = await User.findById(session.userId).select(
    '_id name email role status suspendedUntil',
  );
  if (!user) return undefined;
  if (
    user.status === 'SUSPENDED' &&
    user.suspendedUntil &&
    user.suspendedUntil.getTime() <= Date.now()
  ) {
    await User.updateOne(
      {
        _id: user._id,
        status: 'SUSPENDED',
        suspendedUntil: { $lte: new Date() },
      },
      { $set: { status: 'ACTIVE', suspendedUntil: null } },
    );
    user = await User.findById(user._id).select(
      '_id name email role status suspendedUntil',
    );
  }
  if (!user || user.status !== 'ACTIVE') return undefined;

  return {
    userId: user._id,
    sessionId: session._id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
  };
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = readSessionToken(req.get('cookie'));
  if (!token)
    throw new AppError(
      401,
      'AUTHENTICATION_REQUIRED',
      'Authentication is required',
    );
  const auth = await loadAuth(token);
  if (!auth)
    throw new AppError(
      401,
      'AUTHENTICATION_REQUIRED',
      'Authentication is required',
    );
  req.auth = auth;
  next();
};

export const optionalAuth: RequestHandler = async (req, _res, next) => {
  const token = readSessionToken(req.get('cookie'));
  if (token) req.auth = await loadAuth(token);
  next();
};
