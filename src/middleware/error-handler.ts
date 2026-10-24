import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../shared/errors/app-error.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'The requested resource was not found'));
};

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  _next,
) => {
  if (isPayloadTooLarge(error)) {
    res.status(413).json({
      success: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large',
      },
    });
    return;
  }

  if (isMalformedJson(error)) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request data' },
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
      },
    });
    return;
  }

  if (env.NODE_ENV === 'development') {
    logger.error({ err: error }, 'Unhandled request error');
  } else {
    logger.error(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'Unhandled request error',
    );
  }
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  });
};

function isMalformedJson(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.parse.failed'
  );
}

function isPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 413
  );
}
