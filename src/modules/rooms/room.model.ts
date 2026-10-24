import { Schema, model } from 'mongoose';

export const ROOM_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export interface RoomRecord {
  name: string;
  description: string | null;
  location: string;
  capacity: number;
  status: RoomStatus;
  bookingApprovalVersion: number;
  normalizedName: string;
  normalizedLocation: string;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeRoomIdentityPart(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

const roomSchema = new Schema<RoomRecord>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 120,
    },
    description: {
      type: String,
      default: null,
      maxlength: 2000,
      set(value: string | null | undefined) {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        return trimmed || null;
      },
    },
    location: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    capacity: {
      type: Number,
      required: true,
      min: 1,
      max: 100_000,
      validate: {
        validator: Number.isInteger,
        message: 'Capacity must be an integer',
      },
    },
    status: {
      type: String,
      enum: ROOM_STATUSES,
      required: true,
      default: 'ACTIVE',
    },
    // Internal per-room transaction serialization anchor; omitted from Room DTOs.
    bookingApprovalVersion: {
      type: Number,
      required: true,
      default: 0,
      select: false,
    },
    normalizedName: { type: String, required: true, select: false },
    normalizedLocation: { type: String, required: true, select: false },
  },
  { timestamps: true },
);

roomSchema.index(
  { normalizedName: 1, normalizedLocation: 1 },
  { unique: true },
);
roomSchema.pre('validate', function () {
  this.normalizedName = normalizeRoomIdentityPart(this.name);
  this.normalizedLocation = normalizeRoomIdentityPart(this.location);
});

export const Room = model<RoomRecord>('Room', roomSchema);
