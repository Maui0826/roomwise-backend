import type { Types } from 'mongoose';
import type { UserRole, UserStatus } from '../modules/users/user.model.js';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: Types.ObjectId;
        sessionId: Types.ObjectId;
        name: string;
        email: string;
        role: UserRole;
        status: UserStatus;
      };
    }
  }
}

export {};
