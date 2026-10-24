import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { AppError } from '../shared/errors/app-error.js';

export function validateBody<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fields: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const field = issue.path.map(String).join('.') || 'body';
        (fields[field] ??= []).push(issue.message);
      }
      next(
        new AppError(400, 'VALIDATION_ERROR', 'Invalid request data', fields),
      );
      return;
    }
    req.body = result.data;
    next();
  };
}
