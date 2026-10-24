import type { RequestHandler, Response } from 'express';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  createCsrfToken,
  createOpaqueToken,
  digestToken,
} from '../../shared/utils/crypto.js';
import { normalizeEmail } from '../../shared/utils/email.js';
import { readSessionToken } from './session-token.js';
import { Session } from './session.model.js';
import { User } from '../users/user.model.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  clearSessionCookieOptions,
  sessionCookieOptions,
} from './session-cookie.js';
import type { LoginInput, SignupInput } from './auth.schemas.js';
import type { GoogleLoginInput } from './auth.schemas.js';
import {
  assertGoogleIdentityPolicy,
  isGoogleIdentityConfigurationError,
  verifyGoogleIdentity,
} from './google-identity.service.js';

function publicUser(user: {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: string;
  status: string;
}) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
  };
}

async function issueSession(
  user: {
    _id: Types.ObjectId;
    name: string;
    email: string;
    role: string;
    status: string;
  },
  res: Response,
) {
  const token = createOpaqueToken();
  const expiresAt = new Date(
    Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000,
  );
  await Session.create({
    userId: user._id,
    tokenDigest: digestToken(token),
    expiresAt,
  });
  res.cookie(env.SESSION_COOKIE_NAME, token, sessionCookieOptions());
  return publicUser(user);
}

export const signup: RequestHandler = async (req, res) => {
  const input = req.body as SignupInput;
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await User.create({
      name: input.name.trim(),
      email,
      passwordHash,
      role: 'USER',
      status: 'ACTIVE',
    });
    res.status(201).json({ success: true, data: { user: publicUser(user) } });
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      throw new AppError(
        409,
        'EMAIL_ALREADY_IN_USE',
        'An account with this email already exists',
      );
    }
    throw error;
  }
};

export const login: RequestHandler = async (req, res) => {
  const input = req.body as LoginInput;
  const user = await User.findOne({
    email: normalizeEmail(input.email),
  }).select('+passwordHash');
  const validPassword = await verifyPassword(
    input.password,
    user?.passwordHash,
  );

  if (!user || !validPassword) {
    throw new AppError(
      401,
      'INVALID_CREDENTIALS',
      'Email or password is incorrect',
    );
  }
  await activateExpiredSuspension(user);
  if (user.status !== 'ACTIVE') {
    throw new AppError(
      403,
      user.status === 'INACTIVE' ? 'ACCOUNT_INACTIVE' : 'ACCOUNT_UNAVAILABLE',
      'This account is unavailable',
    );
  }

  const publicProfile = await issueSession(user, res);
  res.status(200).json({ success: true, data: { user: publicProfile } });
};

export const googleLogin: RequestHandler = async (req, res) => {
  const input = req.body as GoogleLoginInput;
  let identity;
  try {
    identity = await verifyGoogleIdentity(input.credential);
  } catch (error) {
    if (isGoogleIdentityConfigurationError(error))
      throw new AppError(
        503,
        'GOOGLE_AUTH_UNAVAILABLE',
        'Google authentication is currently unavailable',
      );
    throw error;
  }
  assertGoogleIdentityPolicy(identity);
  const email = normalizeEmail(identity.email);
  let user = await User.findOne({ googleSubject: identity.subject }).select(
    '+passwordHash +googleSubject',
  );
  if (!user) {
    user = await User.findOne({ email }).select('+passwordHash +googleSubject');
    if (user?.googleSubject && user.googleSubject !== identity.subject)
      throw new AppError(
        409,
        'GOOGLE_ACCOUNT_LINK_CONFLICT',
        'This Google account cannot be linked',
      );
    if (user) {
      user.googleSubject = identity.subject;
      await user.save();
    }
  }
  if (!user) {
    try {
      user = await User.create({
        name: identity.name.trim().slice(0, 100),
        email,
        googleSubject: identity.subject,
        role: 'USER',
        status: 'ACTIVE',
      });
    } catch (error) {
      if (isDuplicateEmailError(error))
        throw new AppError(
          409,
          'GOOGLE_ACCOUNT_LINK_CONFLICT',
          'This Google account cannot be linked',
        );
      throw error;
    }
  }
  await activateExpiredSuspension(user);
  if (user.status !== 'ACTIVE')
    throw new AppError(
      403,
      user.status === 'INACTIVE' ? 'ACCOUNT_INACTIVE' : 'ACCOUNT_UNAVAILABLE',
      'This account is unavailable',
    );
  const publicProfile = await issueSession(user, res);
  res.status(200).json({ success: true, data: { user: publicProfile } });
};

async function activateExpiredSuspension(user: {
  status: string;
  suspendedUntil?: Date | null;
  save(): Promise<unknown>;
}): Promise<void> {
  if (
    user.status === 'SUSPENDED' &&
    user.suspendedUntil &&
    user.suspendedUntil.getTime() <= Date.now()
  ) {
    user.status = 'ACTIVE';
    user.suspendedUntil = null;
    await user.save();
  }
}

export const logout: RequestHandler = async (req, res) => {
  const token = readSessionToken(req.get('cookie'));
  if (token) await Session.deleteOne({ tokenDigest: digestToken(token) });
  res.clearCookie(env.SESSION_COOKIE_NAME, clearSessionCookieOptions());
  res
    .status(200)
    .json({ success: true, data: { message: 'Logged out successfully' } });
};

export const currentUser: RequestHandler = (req, res) => {
  if (!req.auth)
    throw new AppError(
      401,
      'AUTHENTICATION_REQUIRED',
      'Authentication is required',
    );
  res.status(200).json({
    success: true,
    data: {
      user: {
        id: req.auth.userId.toString(),
        name: req.auth.name,
        email: req.auth.email,
        role: req.auth.role,
        status: req.auth.status,
      },
    },
  });
};

export const csrfToken: RequestHandler = (req, res) => {
  const sessionToken = readSessionToken(req.get('cookie'));
  if (!req.auth || !sessionToken) {
    throw new AppError(
      401,
      'AUTHENTICATION_REQUIRED',
      'Authentication is required',
    );
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    success: true,
    data: { csrfToken: createCsrfToken(sessionToken) },
  });
};

function isDuplicateEmailError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11000
  );
}
