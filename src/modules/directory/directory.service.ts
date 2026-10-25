import { google } from 'googleapis';
import {
  env,
  GoogleDirectoryConfigurationError,
  googleDirectoryConfig,
} from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';
import { logger } from '../../config/logger.js';

export interface DirectoryPerson {
  name: string;
  email: string;
}

export interface DirectoryGateway {
  search(query: string, limit: number): Promise<DirectoryPerson[]>;
}

function classifyDirectoryError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN_PROVIDER_ERROR';
  const err = error as Record<string, unknown>;
  const message =
    typeof err.message === 'string' ? err.message.toLowerCase() : '';
  const code = typeof err.code === 'string' ? err.code.toLowerCase() : '';
  let status: number | undefined;
  if (typeof err.status === 'number') {
    status = err.status;
  } else {
    const response = (err as { response?: unknown }).response;
    if (
      response &&
      typeof response === 'object' &&
      typeof (response as { status?: unknown }).status === 'number'
    ) {
      status = (response as { status: number }).status;
    }
  }

  if (code === 'invalid_grant' || message.includes('invalid_grant')) {
    return 'INVALID_GRANT';
  }
  if (
    message.includes('insufficient') ||
    message.includes('scope') ||
    code === 'insufficient_permissions'
  ) {
    return 'INSUFFICIENT_SCOPE';
  }
  if (
    message.includes('people api') ||
    message.includes('disabled') ||
    message.includes('not enabled') ||
    message.includes('has not been used')
  ) {
    return 'PEOPLE_API_DISABLED';
  }
  if (
    message.includes('permission_denied') ||
    message.includes('forbidden') ||
    status === 403
  ) {
    return 'PERMISSION_DENIED';
  }
  if (
    message.includes('directory') &&
    (message.includes('forbidden') || message.includes('not allowed'))
  ) {
    return 'WORKSPACE_DIRECTORY_FORBIDDEN';
  }
  if (status === 429 || message.includes('rate')) {
    return 'PROVIDER_RATE_LIMIT';
  }
  if (status === 503 || status === 500 || message.includes('unavailable')) {
    return 'PROVIDER_UNAVAILABLE';
  }
  if (code === 'eauth' || message.includes('refresh')) {
    return 'OAUTH_REFRESH_FAILED';
  }
  return 'UNKNOWN_PROVIDER_ERROR';
}

function normalizePeople(
  people: Array<Record<string, unknown>>,
): DirectoryPerson[] {
  const results: DirectoryPerson[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    const names = person['names'];
    const emails = person['emailAddresses'];
    const name =
      Array.isArray(names) &&
      typeof names[0] === 'object' &&
      names[0] !== null &&
      'displayName' in names[0] &&
      typeof names[0].displayName === 'string'
        ? names[0].displayName.trim()
        : '';
    const email =
      Array.isArray(emails) &&
      typeof emails[0] === 'object' &&
      emails[0] !== null &&
      'value' in emails[0] &&
      typeof emails[0].value === 'string'
        ? emails[0].value.trim().toLowerCase()
        : '';
    if (!name || !email || seen.has(email)) continue;
    seen.add(email);
    results.push({ name, email });
  }
  return results;
}

export function createGoogleDirectoryGateway(): DirectoryGateway {
  let config;
  try {
    config = googleDirectoryConfig();
  } catch (error) {
    if (error instanceof GoogleDirectoryConfigurationError)
      throw new AppError(
        500,
        'DIRECTORY_CONFIGURATION_ERROR',
        'Directory suggestions are currently unavailable',
      );
    throw error;
  }
  if (!config)
    throw new AppError(
      503,
      'DIRECTORY_UNAVAILABLE',
      'Directory suggestions are currently unavailable',
    );
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
  auth.setCredentials({ refresh_token: config.refreshToken });
  const people = google.people({ version: 'v1', auth });
  return {
    async search(query, limit) {
      try {
        const response = await people.people.searchDirectoryPeople({
          query,
          readMask: 'names,emailAddresses',
          sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
          pageSize: limit,
        });
        return normalizePeople(
          (response.data.people ?? []) as Array<Record<string, unknown>>,
        ).filter((person) =>
          env.GOOGLE_WORKSPACE_DOMAIN
            ? person.email.endsWith(`@${env.GOOGLE_WORKSPACE_DOMAIN}`)
            : true,
        );
      } catch (error) {
        const category = classifyDirectoryError(error);
        try {
          let status: number | undefined;
          const errObj = error as Record<string, unknown>;
          if (typeof errObj.status === 'number') {
            status = errObj.status;
          } else {
            const response = (errObj as { response?: unknown }).response;
            if (
              response &&
              typeof response === 'object' &&
              typeof (response as { status?: unknown }).status === 'number'
            ) {
              status = (response as { status: number }).status;
            }
          }
          logger.warn(
            {
              component: 'google-directory',
              operation: 'searchDirectoryPeople',
              category,
              ...(status !== undefined ? { providerStatus: status } : {}),
              providerReason: category,
              errorName: error instanceof Error ? error.name : 'UnknownError',
            },
            'Directory provider request failed',
          );
        } catch {
          // Never log sensitive details
        }
        throw new AppError(
          503,
          'DIRECTORY_UNAVAILABLE',
          'Directory suggestions are currently unavailable',
        );
      }
    },
  };
}

let gateway: DirectoryGateway | undefined;

export function setDirectoryGatewayForTests(
  value: DirectoryGateway | undefined,
) {
  gateway = value;
}

export async function searchDirectory(
  query: string,
  limit = 8,
): Promise<DirectoryPerson[]> {
  const activeGateway = gateway ?? createGoogleDirectoryGateway();
  return activeGateway.search(query, limit);
}
