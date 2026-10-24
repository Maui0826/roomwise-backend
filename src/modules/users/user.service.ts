import { AppError } from '../../shared/errors/app-error.js';
import type { HydratedDocument } from 'mongoose';
import { User, type UserRecord, type UserStatus } from './user.model.js';
import { Session } from '../auth/session.model.js';
import { normalizeEmail } from '../../shared/utils/email.js';
export interface AdminUserDto {
  id: string;
  name: string;
  email: string;
  role: string;
  status: UserStatus;
  suspendedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}
type UserWithTimestamps = HydratedDocument<UserRecord> & {
  createdAt: Date;
  updatedAt: Date;
};
function dto(user: UserWithTimestamps): AdminUserDto {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    suspendedUntil: user.suspendedUntil?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
export async function listAdminUsers(
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'INACTIVE' | 'ALL',
) {
  const users = await User.find(status === 'ALL' ? {} : { status }).sort({
    name: 1,
    _id: 1,
  });
  return users.map((user) => dto(user as UserWithTimestamps));
}
export async function getAdminUser(id: string) {
  const user = await User.findById(id);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
  return dto(user as UserWithTimestamps);
}
export async function updateAdminUserStatus(
  id: string,
  actorId: string,
  status: UserStatus,
) {
  const user = await User.findById(id);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
  if (user._id.toString() === actorId && status !== 'ACTIVE')
    throw new AppError(
      409,
      'SELF_STATUS_CHANGE_NOT_ALLOWED',
      'You cannot disable your own account',
    );
  if (user.role === 'ADMIN' && status !== 'ACTIVE')
    await assertNotLastActiveAdmin(user._id.toString());
  user.status = status;
  user.suspendedUntil = null;
  await user.save();
  await Session.deleteMany({ userId: user._id });
  return dto(user as UserWithTimestamps);
}

export async function updateAdminUserProfile(
  id: string,
  actorId: string,
  input: { name: string; email: string; role: UserRecord['role'] },
) {
  const user = await getUserDocument(id);
  if (user._id.toString() === actorId && input.role !== 'ADMIN')
    throw new AppError(
      409,
      'SELF_ROLE_CHANGE_NOT_ALLOWED',
      'You cannot remove your own administrator role',
    );
  if (user.role === 'ADMIN' && input.role !== 'ADMIN')
    await assertNotLastActiveAdmin(user._id.toString());
  user.name = input.name.trim();
  user.email = normalizeEmail(input.email);
  user.role = input.role;
  await user.save();
  await Session.deleteMany({ userId: user._id });
  return dto(user as UserWithTimestamps);
}

export async function suspendAdminUser(
  id: string,
  actorId: string,
  days: number,
) {
  const user = await getUserDocument(id);
  if (user._id.toString() === actorId)
    throw new AppError(
      409,
      'SELF_STATUS_CHANGE_NOT_ALLOWED',
      'You cannot suspend your own account',
    );
  if (user.role === 'ADMIN')
    await assertNotLastActiveAdmin(user._id.toString());
  user.status = 'SUSPENDED';
  user.suspendedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  await user.save();
  await Session.deleteMany({ userId: user._id });
  return dto(user as UserWithTimestamps);
}

async function getUserDocument(id: string) {
  const user = await User.findById(id);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
  return user;
}

async function assertNotLastActiveAdmin(id: string): Promise<void> {
  const activeAdmins = await User.countDocuments({
    role: 'ADMIN',
    status: 'ACTIVE',
  });
  const target = await User.findById(id).select('role status');
  if (
    target?.role === 'ADMIN' &&
    target.status === 'ACTIVE' &&
    activeAdmins <= 1
  )
    throw new AppError(
      409,
      'LAST_ACTIVE_ADMIN',
      'At least one active administrator must remain',
    );
}
