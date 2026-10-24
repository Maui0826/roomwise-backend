import { Schema, model, Types } from 'mongoose';

export interface SessionRecord {
  userId: Types.ObjectId;
  tokenDigest: string;
  expiresAt: Date;
  createdAt: Date;
}

const sessionSchema = new Schema<SessionRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenDigest: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

sessionSchema.index({ tokenDigest: 1 }, { unique: true });
sessionSchema.index({ userId: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Session = model<SessionRecord>('Session', sessionSchema);
