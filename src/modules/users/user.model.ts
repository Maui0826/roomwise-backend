import { Schema, model } from 'mongoose';

export const USER_ROLES = ['USER', 'APPROVER', 'ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const USER_STATUSES = [
  'ACTIVE',
  'SUSPENDED',
  'BANNED',
  'INACTIVE',
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserRecord {
  name: string;
  email: string;
  passwordHash?: string;
  googleSubject?: string;
  role: UserRole;
  status: UserStatus;
  suspendedUntil?: Date | null;
}

const userSchema = new Schema<UserRecord>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    passwordHash: { type: String, required: false, select: false },
    role: { type: String, enum: USER_ROLES, required: true, default: 'USER' },
    status: {
      type: String,
      enum: USER_STATUSES,
      required: true,
      default: 'ACTIVE',
    },
    suspendedUntil: { type: Date, default: null },
    googleSubject: { type: String, trim: true, select: false },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        Reflect.deleteProperty(ret, 'passwordHash');
        Reflect.deleteProperty(ret, '__v');
        return ret;
      },
    },
    toObject: {
      transform(_doc, ret) {
        Reflect.deleteProperty(ret, 'passwordHash');
        Reflect.deleteProperty(ret, '__v');
        return ret;
      },
    },
  },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ googleSubject: 1 }, { unique: true, sparse: true });
export const User = model<UserRecord>('User', userSchema);
