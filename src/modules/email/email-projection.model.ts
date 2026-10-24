import { Schema, model, Types } from 'mongoose';

export interface EmailProjectionRecord {
  consumer: 'EMAIL';
  sourceEventId: Types.ObjectId;
  status: 'PROJECTED' | 'FAILED';
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const emailProjectionSchema = new Schema<EmailProjectionRecord>(
  {
    consumer: { type: String, enum: ['EMAIL'], required: true },
    sourceEventId: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ['PROJECTED', 'FAILED'], required: true },
    errorCode: { type: String, default: null, maxlength: 80 },
  },
  { timestamps: true, strict: 'throw' },
);
emailProjectionSchema.index(
  { consumer: 1, sourceEventId: 1 },
  { unique: true, name: 'email_projection_source_idempotency' },
);

export const EmailProjection = model<EmailProjectionRecord>(
  'EmailProjection',
  emailProjectionSchema,
);
