import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

let dummyHash: Promise<string> | undefined;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(
  password: string,
  encodedHash?: string,
): Promise<boolean> {
  const hash =
    encodedHash ??
    (dummyHash ??= hashPassword(randomBytes(32).toString('base64url')));
  try {
    return await argon2.verify(await hash, password);
  } catch {
    return false;
  }
}
