import { env } from '../../config/env.js';

export function readSessionToken(
  cookieHeader: string | undefined,
): string | undefined {
  if (!cookieHeader) return undefined;
  const prefix = `${env.SESSION_COOKIE_NAME}=`;
  const entry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return entry?.slice(prefix.length) || undefined;
}
