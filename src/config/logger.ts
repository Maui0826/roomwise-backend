import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level:
    env.NODE_ENV === 'test'
      ? 'silent'
      : env.NODE_ENV === 'development'
        ? 'debug'
        : 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers.x-csrf-token',
      'csrfToken',
      'passwordHash',
      'password',
      'token',
      'secret',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
