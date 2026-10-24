import { AppError } from '../../shared/errors/app-error.js';
import { normalizeEmail } from '../../shared/utils/email.js';
import { User } from '../users/user.model.js';
import { hashPassword } from './password.js';
import { signupSchema, type SignupInput } from './auth.schemas.js';

export interface PreparedAdminInput {
  name: string;
  email: string;
  password: string;
}

export function prepareAdminInput(input: unknown): PreparedAdminInput {
  const result = signupSchema.safeParse(input);
  if (!result.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const field = issue.path.map(String).join('.') || 'input';
      (fields[field] ??= []).push(issue.message);
    }
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Invalid admin bootstrap input',
      fields,
    );
  }
  return { ...result.data, email: normalizeEmail(result.data.email) };
}

export async function createInitialAdmin(
  input: PreparedAdminInput,
): Promise<{ id: string; email: string }> {
  const signup: SignupInput = prepareAdminInput(input);
  if (await User.exists({ email: signup.email }))
    throw adminBootstrapConflict();

  const passwordHash = await hashPassword(signup.password);
  try {
    const user = await User.create({
      name: signup.name,
      email: signup.email,
      passwordHash,
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    return { id: user._id.toString(), email: user.email };
  } catch (error) {
    if (isDuplicateKeyError(error)) throw adminBootstrapConflict();
    throw error;
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11000
  );
}

function adminBootstrapConflict(): AppError {
  return new AppError(
    409,
    'ADMIN_BOOTSTRAP_CONFLICT',
    'An account with this email already exists; no changes were made',
  );
}
