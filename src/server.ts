import 'dotenv/config';
import { createServer } from 'node:http';
import { app } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

const server = createServer(app);
let shuttingDown = false;

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
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
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
  server.listen(env.PORT, () => {
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
