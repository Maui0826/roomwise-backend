import { google } from 'googleapis';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';

export interface VerifiedGoogleIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
  hostedDomain?: string;
}

export interface GoogleIdentityVerifier {
  verify(credential: string): Promise<VerifiedGoogleIdentity>;
}

class GoogleIdentityConfigurationError extends Error {}

function createVerifier(): GoogleIdentityVerifier {
  return {
    async verify(credential) {
      if (!env.GOOGLE_AUTH_CLIENT_ID)
        throw new GoogleIdentityConfigurationError(
          'Google authentication is not configured',
        );
      try {
        const client = new google.auth.OAuth2(env.GOOGLE_AUTH_CLIENT_ID);
        const ticket = await client.verifyIdToken({
          idToken: credential,
          audience: env.GOOGLE_AUTH_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email || !payload.name)
          throw new Error('Incomplete Google identity');
        return {
          subject: payload.sub,
          email: payload.email,
          emailVerified: payload.email_verified === true,
          name: payload.name,
          ...(payload.hd ? { hostedDomain: payload.hd } : {}),
        };
      } catch {
        throw new AppError(
          401,
          'GOOGLE_CREDENTIAL_INVALID',
          'Google authentication could not be verified',
        );
      }
    },
  };
}

let activeVerifier: GoogleIdentityVerifier = createVerifier();

export function setGoogleIdentityVerifierForTests(
  verifier: GoogleIdentityVerifier | undefined,
) {
  activeVerifier = verifier ?? createVerifier();
}

export function verifyGoogleIdentity(credential: string) {
  return activeVerifier.verify(credential);
}

export function assertGoogleIdentityPolicy(identity: VerifiedGoogleIdentity) {
  if (!identity.emailVerified)
    throw new AppError(
      401,
      'GOOGLE_CREDENTIAL_INVALID',
      'Google authentication could not be verified',
    );
  if (
    env.GOOGLE_WORKSPACE_DOMAIN &&
    identity.hostedDomain !== env.GOOGLE_WORKSPACE_DOMAIN
  )
    throw new AppError(
      403,
      'GOOGLE_DOMAIN_NOT_ALLOWED',
      'This Google account is not allowed',
    );
}

export function isGoogleIdentityConfigurationError(error: unknown): boolean {
  return error instanceof GoogleIdentityConfigurationError;
}
