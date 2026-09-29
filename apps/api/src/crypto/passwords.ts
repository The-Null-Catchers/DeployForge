import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1).
 */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, algorithm: 2 /* Argon2id */ } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await verify(hashValue, password);
  } catch {
    return false;
  }
}

/** Used to equalize timing when the user does not exist. */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hash('deployforge-timing-equalizer', OPTIONS);
  await verifyPassword(await dummyHash, password);
}
