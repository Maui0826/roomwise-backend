import { AppError } from '../../shared/errors/app-error.js';
import { Room, type RoomRecord, type RoomStatus } from './room.model.js';
import type {
  CreateRoomInput,
  UpdateRoomInput,
  AvailabilityQuery,
} from './room.schemas.js';
import { checkBookingConflict } from '../bookings/booking.service.js';
import {
  bookingWindow,
  parseBookingInterval,
  validateBookingDate,
  validateFutureStart,
} from '../bookings/booking.time.js';
import { env } from '../../config/env.js';

export interface RoomDto {
  id: string;
  name: string;
  description: string | null;
  location: string;
  capacity: number;
  status: RoomStatus;
  createdAt: string;
  updatedAt: string;
}

export function toRoomDto(
  room: RoomRecord & { _id: { toString(): string } },
): RoomDto {
  return {
    id: room._id.toString(),
    name: room.name,
    description: room.description ?? null,
    location: room.location,
    capacity: room.capacity,
    status: room.status,
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
  };
}

export async function createRoom(input: CreateRoomInput): Promise<RoomDto> {
  try {
    const room = await Room.create({
      name: input.name,
      description: input.description ?? null,
      location: input.location,
      capacity: input.capacity,
      status: 'ACTIVE',
    });
    return toRoomDto(room);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw roomAlreadyExists();
    throw error;
  }
}

export async function listActiveRooms(): Promise<RoomDto[]> {
  const rooms = await Room.find({ status: 'ACTIVE' }).sort({
    name: 1,
    location: 1,
    _id: 1,
  });
  return rooms.map(toRoomDto);
}

export async function listAdminRooms(
  status: 'ACTIVE' | 'INACTIVE' | 'ALL',
): Promise<RoomDto[]> {
  const filter = status === 'ALL' ? {} : { status };
  const rooms = await Room.find(filter).sort({ name: 1, location: 1, _id: 1 });
  return rooms.map(toRoomDto);
}

export async function getRoom(
  roomId: string,
  includeInactive: boolean,
): Promise<RoomDto> {
  const room = await Room.findById(roomId);
  if (!room || (!includeInactive && room.status !== 'ACTIVE')) {
    throw roomNotFound();
  }
  return toRoomDto(room);
}

export async function updateRoom(
  roomId: string,
  input: UpdateRoomInput,
): Promise<RoomDto> {
  const room = await Room.findById(roomId);
  if (!room) throw roomNotFound();

  if (input.name !== undefined) room.name = input.name;
  if (input.description !== undefined) room.description = input.description;
  if (input.location !== undefined) room.location = input.location;
  if (input.capacity !== undefined) room.capacity = input.capacity;

  try {
    await room.save();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw roomAlreadyExists();
    throw error;
  }
  return toRoomDto(room);
}

export async function updateRoomStatus(
  roomId: string,
  status: RoomStatus,
): Promise<RoomDto> {
  const room = await Room.findById(roomId);
  if (!room) throw roomNotFound();
  room.status = status;
  await room.save();
  return toRoomDto(room);
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11000
  );
}

function roomAlreadyExists(): AppError {
  return new AppError(
    409,
    'ROOM_ALREADY_EXISTS',
    'A room with this name and location already exists',
  );
}

function roomNotFound(): AppError {
  return new AppError(404, 'ROOM_NOT_FOUND', 'Room was not found');
}

export interface AvailabilityDto {
  available: boolean;
  bookingWindow: { minimumDate: string; maximumDate: string };
  timezone: string;
}

export async function checkRoomAvailability(
  roomId: string,
  query: AvailabilityQuery,
  now: Date = new Date(),
): Promise<AvailabilityDto> {
  const room = await Room.findById(roomId);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room was not found');
  if (room.status !== 'ACTIVE')
    throw new AppError(
      409,
      'ROOM_INACTIVE',
      'Room is not available for new bookings',
    );

  const timezone = env.APP_TIMEZONE;
  validateBookingDate(query.date, now, timezone);

  const interval = parseBookingInterval(
    query.date,
    query.startTime,
    query.endTime,
    timezone,
  );
  validateFutureStart(interval.startAt, now);

  const hasConflict = await checkBookingConflict(
    room._id,
    interval.startAt,
    interval.endAt,
  );

  const window = bookingWindow(now, timezone);
  return {
    available: !hasConflict,
    bookingWindow: {
      minimumDate: window.today,
      maximumDate: window.maximumDate,
    },
    timezone,
  };
}
