import { Schema, model, type Types } from 'mongoose';

export const AUDIT_CATEGORIES = [
  'AUTH',
  'SESSION',
  'USER',
  'ROOM',
  'BOOKING',
  'CALENDAR',
  'EMAIL',
  'FILE',
  'SECURITY',
  'SYSTEM',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export const AUDIT_OUTCOMES = ['SUCCESS', 'FAILURE', 'DENIED'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];
export const AUDIT_SOURCES = ['HTTP', 'WORKER', 'SYSTEM', 'CLI'] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export interface AuditEventRecord {
  occurredAt: Date;
  category: AuditCategory;
  action: string;
  outcome: AuditOutcome;
  actor?: { userId?: Types.ObjectId; role?: string };
  sessionIdFingerprint?: string;
  request?: {
    requestId?: string;
    method?: string;
    route?: string;
    statusCode?: number;
  };
  target?: { resourceType: string; resourceId?: string };
  metadata?: Record<string, unknown>;
  source: AuditSource;
  schemaVersion: number;
}

const auditSchema = new Schema(
  {
    occurredAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    category: {
      type: String,
      enum: AUDIT_CATEGORIES,
      required: true,
      immutable: true,
    },
    action: { type: String, required: true, maxlength: 120, immutable: true },
    outcome: {
      type: String,
      enum: AUDIT_OUTCOMES,
      required: true,
      immutable: true,
    },
    actor: {
      userId: { type: Schema.Types.ObjectId, ref: 'User', immutable: true },
      role: { type: String, maxlength: 30, immutable: true },
    },
    sessionIdFingerprint: {
      type: String,
      maxlength: 128,
      immutable: true,
      select: false,
    },
    request: {
      requestId: { type: String, maxlength: 128, immutable: true },
      method: { type: String, maxlength: 12, immutable: true },
      route: { type: String, maxlength: 200, immutable: true },
      statusCode: { type: Number, immutable: true },
    },
    target: {
      resourceType: { type: String, maxlength: 80, immutable: true },
      resourceId: { type: String, maxlength: 128, immutable: true },
    },
    metadata: { type: Schema.Types.Mixed, immutable: true },
    source: {
      type: String,
      enum: AUDIT_SOURCES,
      required: true,
      immutable: true,
    },
    schemaVersion: {
      type: Number,
      required: true,
      default: 1,
      immutable: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: true },
);
auditSchema.index({ occurredAt: -1, category: 1 });
auditSchema.index({ 'actor.userId': 1, occurredAt: -1 });
auditSchema.index({
  'target.resourceType': 1,
  'target.resourceId': 1,
  occurredAt: -1,
});
export const AuditEvent = model<AuditEventRecord>('AuditEvent', auditSchema);
