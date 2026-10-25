import { timingSafeEqual, randomBytes } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { WorkerHandle } from '../../worker-process.js';

/**
 * Constant-time comparison of two strings.
 * Returns false if either input is falsy or they differ in length/content.
 *
 * Uses timingSafeEqual to avoid timing-oracle attacks. Buffers are
 * compared as UTF-8; length mismatch is handled without branching on the
 * secret itself.
 */
function safeCompareSecret(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Consume time with a dummy comparison to avoid length-oracle.
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Verify the Authorization: Bearer <secret> header against the configured
 * WORKER_TRIGGER_SECRET. Returns true only when the header is present,
 * well-formed, and the secret matches in constant time.
 *
 * Reads WORKER_TRIGGER_SECRET from process.env at request time so the
 * value can be changed between tests without reloading the module.
 *
 * Returns false (no detail logged) when the secret is absent or wrong,
 * to avoid enumeration attacks.
 */
function verifyBearerSecret(authorizationHeader: string | undefined): boolean {
  // Read at request time, not module load time, to support test overrides.
  const configured = process.env.WORKER_TRIGGER_SECRET;
  if (!configured) return false;
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer '))
    return false;
  const provided = authorizationHeader.slice('Bearer '.length);
  return safeCompareSecret(provided, configured);
}

/** Conservative rate limit: at most 20 requests per 10 minutes. */
const schedulerRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Avoid fingerprinting the endpoint type in the public response.
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS' } },
  skip: () => env.NODE_ENV === 'test',
});

/**
 * Create the internal scheduler router.
 *
 * @param workerHandle - The running embedded worker handle, or null if the
 *   embedded worker is not active (endpoint then returns 503).
 *
 * Route: POST /api/internal/worker/tick
 *
 * Authentication: Authorization: Bearer <WORKER_TRIGGER_SECRET>
 *   - Server-side only secret, never a user session or CSRF token.
 *   - Missing or wrong secret → generic 401 (no detail).
 *
 * CSRF: This route does NOT use browser session cookies or require CSRF
 *   tokens. It is machine-to-machine only and is authenticated exclusively
 *   by the dedicated bearer secret.
 *
 * Effect: Invokes a single bounded batch of outbox work using the worker's
 *   own handlers and lease semantics. Idempotent; safe to call concurrently
 *   (in-flight tick is skipped gracefully).
 *
 * The route DOES NOT:
 *   - accept booking IDs or event types as input
 *   - accept recipient addresses
 *   - bypass booking state rules
 *   - return sensitive work payload details
 *   - expose whether a tick did nothing vs. found work (only HTTP 200/error)
 */
export function createInternalWorkerRouter(
  workerHandle: WorkerHandle | null,
): Router {
  const router = Router();

  router.post(
    '/tick',
    schedulerRateLimit,
    async (req, res, next): Promise<void> => {
      try {
        // Authenticate with dedicated bearer secret. Deliberately returns
        // the same response for missing vs. wrong to avoid enumeration.
        if (!verifyBearerSecret(req.get('authorization'))) {
          logger.warn(
            { ip: req.ip, path: req.path },
            'Internal scheduler tick: unauthorized request',
          );
          res
            .status(401)
            .json({ success: false, error: { code: 'UNAUTHORIZED' } });
          return;
        }

        if (!workerHandle) {
          // Embedded worker is not running in this process.
          res.status(503).json({
            success: false,
            error: { code: 'WORKER_NOT_RUNNING' },
          });
          return;
        }

        // Process a bounded batch. tick() is concurrency-safe and
        // idempotent when called while a tick is already in flight.
        await workerHandle.tick();

        res.status(200).json({ success: true });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

/**
 * Generate a cryptographically random secret suitable for use as
 * WORKER_TRIGGER_SECRET. For operator convenience only; never committed.
 */
export function generateWorkerTriggerSecret(): string {
  return randomBytes(32).toString('hex');
}
