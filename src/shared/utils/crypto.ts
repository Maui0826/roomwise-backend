import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createCsrfToken(sessionToken: string): string {
  return createHmac('sha256', sessionToken)
    .update('booking-management-csrf-v1', 'utf8')
    .digest('base64url');
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
