import { rateLimit } from 'express-rate-limit';
import type { Request } from 'express';
import { AppError } from '../../shared/errors/app-error.js';

export const bookingCreateRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(req: Request) {
    return req.auth?.userId.toString() ?? 'unauthenticated';
  },
  handler(_req, _res, next) {
    next(
      new AppError(
        429,
        'RATE_LIMITED',
        'Too many booking requests. Please try again later.',
      ),
    );
  },
});
