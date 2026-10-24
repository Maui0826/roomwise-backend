import type { RequestHandler } from 'express';
import type { UserRole } from '../modules/users/user.model.js';
import { AppError } from '../shared/errors/app-error.js';

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(
        new AppError(
          401,
          'AUTHENTICATION_REQUIRED',
          'Authentication is required',
        ),
      );
      return;
    }
    if (!roles.includes(req.auth.role)) {
      next(
        new AppError(
          403,
          'FORBIDDEN',
          'You do not have permission to perform this action',
        ),
      );
      return;
    }
    next();
  };
}
