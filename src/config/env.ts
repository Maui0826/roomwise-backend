import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  APP_TIMEZONE: z
    .string()
    .default('Asia/Manila')
    .refine((timezone) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
      } catch {
        return false;
      }
    }, 'APP_TIMEZONE must be a valid IANA timezone'),
  FRONTEND_ORIGINS: z.string().default('http://localhost:5173'),
  SESSION_COOKIE_NAME: z.string().min(1).default('booking_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  OUTBOX_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(1_000),
  OUTBOX_LOCK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(60_000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  OUTBOX_RETRY_BASE_DELAY_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300_000)
    .default(1_000),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().optional(),
  GMAIL_SENDER_EMAIL: z.string().optional(),
  GOOGLE_AUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_WORKSPACE_DOMAIN: z.string().trim().toLowerCase().optional(),
  GOOGLE_DIRECTORY_CLIENT_ID: z.string().optional(),
  GOOGLE_DIRECTORY_CLIENT_SECRET: z.string().optional(),
  GOOGLE_DIRECTORY_REFRESH_TOKEN: z.string().optional(),
  ADMIN_NAME: z.string().optional(),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map(
    ({ path, message }) => `${path.join('.')}: ${message}`,
  );
  throw new Error(`Invalid environment configuration: ${issues.join('; ')}`);
}

function parseOrigins(value: string): string[] {
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (const origin of origins) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error(
        'FRONTEND_ORIGINS must contain comma-separated origin URLs',
      );
    }
    if (
      parsedOrigin.origin !== origin ||
      !['http:', 'https:'].includes(parsedOrigin.protocol)
    ) {
      throw new Error(
        'FRONTEND_ORIGINS entries must be HTTP(S) origins without paths',
      );
    }
  }

  return origins;
}

export const env = Object.freeze({
  ...parsed.data,
  frontendOrigins: parseOrigins(parsed.data.FRONTEND_ORIGINS),
});

export class GoogleDirectoryConfigurationError extends Error {}

export function googleDirectoryConfig(
  values = {
    clientId: env.GOOGLE_DIRECTORY_CLIENT_ID,
    clientSecret: env.GOOGLE_DIRECTORY_CLIENT_SECRET,
    refreshToken: env.GOOGLE_DIRECTORY_REFRESH_TOKEN,
  },
) {
  const configured = Object.values(values).filter(Boolean).length;
  if (configured === 0) return null;
  if (configured !== Object.values(values).length)
    throw new GoogleDirectoryConfigurationError();
  return {
    clientId: values.clientId!,
    clientSecret: values.clientSecret!,
    refreshToken: values.refreshToken!,
  };
}

export function requireCalendarConfig() {
  const names = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_CALENDAR_ID',
  ] as const;
  const missing = names.filter((name) => !env[name]);
  if (missing.length)
    throw new Error(
      `Missing Calendar worker configuration: ${missing.join(', ')}`,
    );
  return {
    clientId: env.GOOGLE_CLIENT_ID!,
    clientSecret: env.GOOGLE_CLIENT_SECRET!,
    refreshToken: env.GOOGLE_REFRESH_TOKEN!,
    calendarId: env.GOOGLE_CALENDAR_ID!,
  };
}

export function requireGmailConfig() {
  const common = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
  ] as const;
  const missing: string[] = common.filter((name) => !env[name]);
  if (!env.GMAIL_SENDER_EMAIL) missing.push('GMAIL_SENDER_EMAIL');
  if (missing.length)
    throw new Error(
      `Missing Gmail worker configuration: ${missing.join(', ')}`,
    );
  const senderEmail = env.GMAIL_SENDER_EMAIL!.trim().toLowerCase();
  if (!z.string().email().max(254).safeParse(senderEmail).success) {
    throw new Error('GMAIL_SENDER_EMAIL must be a valid email address');
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID!,
    clientSecret: env.GOOGLE_CLIENT_SECRET!,
    refreshToken: env.GOOGLE_REFRESH_TOKEN!,
    senderEmail,
  };
}
