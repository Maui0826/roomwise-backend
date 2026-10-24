import type { RequestHandler } from 'express';
import { recordAudit } from '../modules/audit/audit.service.js';

const SKIP = new Set(['/api/health']);

export const auditRequest: RequestHandler = (req, res, next) => {
  res.once('finish', () => {
    if (
      SKIP.has(req.path) ||
      req.method === 'GET' ||
      req.method === 'HEAD' ||
      req.method === 'OPTIONS'
    )
      return;
    const path = req.path;
    const category = path.startsWith('/api/auth')
      ? 'AUTH'
      : path.startsWith('/api/admin/users')
        ? 'USER'
        : path.startsWith('/api/admin/rooms') || path.startsWith('/api/rooms')
          ? 'ROOM'
          : path.includes('bookings')
            ? 'BOOKING'
            : 'SYSTEM';
    const outcome =
      res.statusCode >= 400
        ? res.statusCode === 401 || res.statusCode === 403
          ? 'DENIED'
          : 'FAILURE'
        : 'SUCCESS';
    void recordAudit({
      req,
      category,
      action: `${req.method} ${path}`,
      outcome,
    });
  });
  next();
};
