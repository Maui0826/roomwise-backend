import { Schema, model, Types } from 'mongoose';

export interface ReminderProjectionRecord {
  consumer: 'REMINDERS';
  sourceEventId: Types.ObjectId;
  status: 'PROJECTED' | 'FAILED';
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const reminderProjectionSchema = new Schema<ReminderProjectionRecord>(
  {
    consumer: { type: String, enum: ['REMINDERS'], required: true },
    sourceEventId: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ['PROJECTED', 'FAILED'], required: true },
    errorCode: { type: String, default: null, maxlength: 80 },
  },
  { timestamps: true, strict: 'throw' },
);
reminderProjectionSchema.index(
  { consumer: 1, sourceEventId: 1 },
  { unique: true, name: 'reminder_projection_source_idempotency' },
);

export const ReminderProjection = model<ReminderProjectionRecord>(
  'ReminderProjection',
  reminderProjectionSchema,
);
