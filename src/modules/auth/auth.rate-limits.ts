import { createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import type { Request } from 'express';
import { AppError } from '../../shared/errors/app-error.js';
import { normalizeEmail } from '../../shared/utils/email.js';

function limited(
  _req: Request,
  _res: unknown,
  next: (error?: unknown) => void,
): void {
  next(
    new AppError(
      429,
      'RATE_LIMITED',
      'Too many authentication attempts. Please try again later.',
    ),
  );
}

const common = {
  standardHeaders: true as const,
  legacyHeaders: false,
  handler: limited,
};

export const signupRateLimit = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 10,
});

export const loginIpRateLimit = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 10,
});

export const loginAccountRateLimit = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator(req) {
    const body: unknown = req.body;
    const email =
      typeof body === 'object' &&
      body !== null &&
      'email' in body &&
      typeof body.email === 'string'
        ? normalizeEmail(body.email)
        : 'invalid-account-input';
    return createHash('sha256').update(email).digest('hex');
  },
});

export const googleLoginRateLimit = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 10,
});
