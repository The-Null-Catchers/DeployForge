import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify GitHub's X-Hub-Signature-256 over the exact raw request body using a
 * constant-time comparison. Parsing and re-serializing JSON would change the
 * bytes, so callers must pass the raw body.
 */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const provided = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function signGithubPayload(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
