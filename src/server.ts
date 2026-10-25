import 'dotenv/config';
import { createServer } from 'node:http';
import { app } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { createInternalWorkerRouter } from './modules/internal/worker-tick.routes.js';
import type { WorkerHandle } from './worker-process.js';

const server = createServer(app);
let shuttingDown = false;
let embeddedWorker: WorkerHandle | null = null;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown started');

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    // Stop HTTP server first to stop accepting new requests.
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });

    // Stop the embedded worker if running; wait for it to drain.
    if (embeddedWorker) {
      embeddedWorker.stop();
      await embeddedWorker.stopped.catch((err: unknown) => {
        logger.error(
          { errorName: err instanceof Error ? err.name : 'UnknownError' },
          'Embedded worker did not stop cleanly during shutdown',
        );
      });
    }

    await disconnectDatabase();
    clearTimeout(forceExit);
    process.exit(exitCode);
  } catch (error) {
    logger.error({ err: error }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await connectDatabase();

  // --- Embedded worker mode (Render Free Tier) ---
  //
  // When RUN_WORKER_IN_WEB=true, the outbox background worker runs inside
  // this same Node process alongside the Express API. Both share the same
  // MongoDB connection pool and configuration.
  //
  // IMPORTANT: Do NOT set RUN_WORKER_IN_WEB=true while also running
  // `npm run worker` (or deploying a dedicated Render Background Worker)
  // pointing at the same database. Mongo leases prevent duplicate delivery
  // of individual events, but accidental duplicate consumers create
  // unnecessary contention. Use one mode at a time.
  //
  // For local development, leave RUN_WORKER_IN_WEB unset/false and run
  // `npm run worker:dev` separately to avoid unintended Google/Gmail
  // side effects during normal development.
  if (env.RUN_WORKER_IN_WEB) {
    logger.info('Embedded worker mode: starting outbox worker in web process');
    // Import dynamically so worker Google credentials are not required
    // when RUN_WORKER_IN_WEB is false (the normal local-dev case).
    const { startWorkerProcess } = await import('./worker-process.js');
    embeddedWorker = startWorkerProcess();
    logger.info(
      { workerId: embeddedWorker.workerId },
      'Embedded worker started',
    );
  }

  // Mount the internal scheduler tick router. Pass the worker handle so
  // the route can delegate bounded processing. When embeddedWorker is null
  // (worker not running in this process), the route returns 503.
  app.use(
    '/api/internal/worker',
    createInternalWorkerRouter(embeddedWorker),
  );

  // Bind to 0.0.0.0 so Render's port scanner detects the open port.
  // Render supplies PORT at runtime; 3000 is used as a local fallback only.
  server.listen(env.PORT, '0.0.0.0', () => {
    logger.info(
      { port: env.PORT, environment: env.NODE_ENV },
      'HTTP server listening',
    );
  });
} catch (error) {
  const startupError =
    env.NODE_ENV === 'development'
      ? { err: error }
      : { errorName: error instanceof Error ? error.name : 'UnknownError' };
  logger.fatal(startupError, 'Application startup failed');
  await disconnectDatabase().catch((disconnectError: unknown) => {
    logger.error(
      { err: disconnectError },
      'Database cleanup after startup failure failed',
    );
  });
  process.exit(1);
}
