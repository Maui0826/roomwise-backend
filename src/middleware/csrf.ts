import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../shared/errors/app-error.js';
import { createCsrfToken, safeEqual } from '../shared/utils/crypto.js';
import { readSessionToken } from '../modules/auth/session-token.js';

export const validateRequestOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.get('origin');
  if (origin && !env.frontendOrigins.includes(origin)) {
    next(new AppError(403, 'CSRF_INVALID', 'Request origin is not allowed'));
    return;
  }
  next();
};

export const requireCsrf: RequestHandler = (req, _res, next) => {
  const sessionToken = readSessionToken(req.get('cookie'));
  const submittedToken = req.get('x-csrf-token');
  if (
    !sessionToken ||
    !submittedToken ||
    !safeEqual(createCsrfToken(sessionToken), submittedToken)
  ) {
    next(new AppError(403, 'CSRF_INVALID', 'A valid CSRF token is required'));
    return;
  }
  next();
};

export const requireCsrfWhenAuthenticated: RequestHandler = (
  req,
  res,
  next,
) => {
  if (!req.auth) {
    next();
    return;
  }
  requireCsrf(req, res, next);
};
