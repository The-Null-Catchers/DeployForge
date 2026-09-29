import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(prefix = '', bytes = 32): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still spend comparable time to avoid a trivial length oracle.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Stateless signed access tokens for native clients. They carry the session
 * ID, and every request re-validates the session, so revocation is immediate.
 */
export interface AccessTokenPayload {
  sid: string;
  uid: string;
  exp: number;
}

export function signAccessToken(payload: AccessTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(`dfa.${body}`).digest('base64url');
  return `dfa_${body}.${mac}`;
}

export function verifyAccessToken(token: string, secret: string, now = Date.now()): AccessTokenPayload | null {
  if (!token.startsWith('dfa_')) return null;
  const [body, mac] = token.slice(4).split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(`dfa.${body}`).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessTokenPayload;
    if (typeof payload.sid !== 'string' || typeof payload.uid !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}
