import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { AppError } from './shared/errors/app-error.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { adminRoomsRouter, roomsRouter } from './modules/rooms/room.routes.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import {
  approverBookingsRouter,
  bookingsRouter,
} from './modules/bookings/booking.routes.js';
import { adminUsersRouter } from './modules/users/user.routes.js';
import { directoryRouter } from './modules/directory/directory.routes.js';
import { auditRequest } from './middleware/audit-request.js';

export const app = express();

// Render forwards one proxy hop in front of the service. Revisit if deployment topology changes.
if (env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}
app.disable('x-powered-by');

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (origin === undefined || env.frontendOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(
        new AppError(403, 'CSRF_INVALID', 'Request origin is not allowed'),
      );
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(pinoHttp({ logger }));
app.use(auditRequest);

app.get('/api/health', (_req, res) => {
  res.status(200).json({ success: true, data: { status: 'ok' } });
});

app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/admin/rooms', adminRoomsRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/approver/bookings', approverBookingsRouter);
app.use('/api/admin/users', adminUsersRouter);
app.use('/api/directory', directoryRouter);

app.use(notFoundHandler);
app.use(errorHandler);
