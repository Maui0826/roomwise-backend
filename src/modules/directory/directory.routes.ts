import { Router } from 'express';
import { requireAuth } from '../../middleware/authentication.js';
import { validateQuery } from '../../middleware/validate-route.js';
import { directorySearchSchema } from './directory.schemas.js';
import { search } from './directory.controller.js';
import { rateLimit } from 'express-rate-limit';
import { AppError } from '../../shared/errors/app-error.js';

const directoryRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) =>
    next(new AppError(429, 'RATE_LIMITED', 'Too many directory searches')),
});

export const directoryRouter = Router();
directoryRouter.get(
  '/search',
  requireAuth,
  directoryRateLimit,
  validateQuery(directorySearchSchema),
  search,
);
