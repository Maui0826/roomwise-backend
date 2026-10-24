import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { AppError } from '../shared/errors/app-error.js';

function validationFailure(
  issues: { path: PropertyKey[]; message: string }[],
): AppError {
  const fields: Record<string, string[]> = {};
  for (const issue of issues) {
    const field = issue.path.map(String).join('.') || 'request';
    (fields[field] ??= []).push(issue.message);
  }
  return new AppError(400, 'VALIDATION_ERROR', 'Invalid request data', fields);
}

export function validateParams<T extends ZodTypeAny>(
  schema: T,
): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      next(validationFailure(result.error.issues));
      return;
    }
    req.params = result.data as typeof req.params;
    next();
  };
}

export function validateQuery<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(validationFailure(result.error.issues));
      return;
    }
    res.locals.validatedQuery = result.data;
    next();
  };
}
