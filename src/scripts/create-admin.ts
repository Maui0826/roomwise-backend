import 'dotenv/config';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { logger } from '../config/logger.js';
import {
  createInitialAdmin,
  prepareAdminInput,
} from '../modules/auth/admin-bootstrap.js';
import { AppError } from '../shared/errors/app-error.js';

async function main(): Promise<void> {
  try {
    const input = prepareAdminInput({
      name: env.ADMIN_NAME,
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
    });
    await connectDatabase();
    const admin = await createInitialAdmin(input);
    console.info(`Admin account created successfully: ${admin.email}`);
  } catch (error) {
    if (error instanceof AppError) {
      console.error(error.message);
    } else {
      logger.error(
        { errorName: error instanceof Error ? error.name : 'UnknownError' },
        'Admin bootstrap failed',
      );
      console.error(
        'Admin bootstrap failed; check database connectivity and configuration.',
      );
    }
    process.exitCode = 1;
  } finally {
    try {
      await disconnectDatabase();
    } catch {
      logger.error('Admin bootstrap database cleanup failed');
      process.exitCode = 1;
    }
  }
}

await main();
