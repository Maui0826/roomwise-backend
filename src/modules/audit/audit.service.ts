import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  AuditEvent,
  type AuditCategory,
  type AuditOutcome,
  type AuditSource,
} from './audit.model.js';
import { logger } from '../../config/logger.js';

const SECRET_KEYS =
  /password|token|secret|authorization|cookie|csrf|credential|refresh/i;
const ALLOWED_METADATA_KEYS = new Set([
  'provider',
  'errorCode',
  'changedFields',
  'fromStatus',
  'toStatus',
  'roomId',
  'bookingId',
  'userId',
  'reasonCode',
]);

export type AuditInput = {
  category: AuditCategory;
  action: string;
  outcome: AuditOutcome;
  source?: AuditSource;
  req?: Request;
  target?: { resourceType: string; resourceId?: string };
  metadata?: Record<string, unknown>;
  sessionToken?: string;
};

export function sanitizeAuditMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_METADATA_KEYS.has(key) || SECRET_KEYS.test(key)) continue;
    if (Array.isArray(value)) {
      result[key] = value
        .filter(
          (item) =>
            typeof item === 'string' ||
            typeof item === 'number' ||
            typeof item === 'boolean',
        )
        .slice(0, 20);
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      result[key] = value;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function fingerprintSession(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const req = input.req;
    await AuditEvent.create({
      category: input.category,
      action: input.action,
      outcome: input.outcome,
      source: input.source ?? (req ? 'HTTP' : 'SYSTEM'),
      actor: req?.auth
        ? { userId: req.auth.userId, role: req.auth.role }
        : undefined,
      sessionIdFingerprint: input.sessionToken
        ? fingerprintSession(input.sessionToken)
        : undefined,
      request: req
        ? {
            requestId: typeof req.id === 'string' ? req.id : undefined,
            method: req.method,
            route: req.route?.path ? String(req.route.path) : req.path,
            statusCode: req.res?.statusCode ?? 500,
          }
        : undefined,
      target: input.target,
      metadata: sanitizeAuditMetadata(input.metadata),
      schemaVersion: 1,
    });
  } catch (error) {
    logger.error(
      { err: error, auditAction: input.action },
      'Audit event write failed',
    );
  }
}
