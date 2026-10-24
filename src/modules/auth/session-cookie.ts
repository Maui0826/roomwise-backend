import type { CookieOptions } from 'express';
import { env } from '../../config/env.js';

export function sessionCookieOptions(
  isProduction = env.NODE_ENV === 'production',
): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/api',
    maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
  };
}

export function clearSessionCookieOptions(): CookieOptions {
  const { httpOnly, secure, sameSite, path } = sessionCookieOptions();
  return { httpOnly, secure, sameSite, path };
}
