import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SecretBox } from './secret-box';
import { signAccessToken, verifyAccessToken, safeEqual } from './tokens';

const key = () => randomBytes(32).toString('base64');

describe('SecretBox (AES-256-GCM)', () => {
  const k1 = key();
  const box = new SecretBox(`k1:${k1}`, 'k1');

  it('round-trips values and uses a fresh IV each time', () => {
    const a = box.encrypt('s3cr3t value', 'env:app:KEY');
    const b = box.encrypt('s3cr3t value', 'env:app:KEY');
    expect(a).not.toEqual(b);
    expect(a.startsWith('df1.k1.')).toBe(true);
    expect(box.decrypt(a, 'env:app:KEY')).toBe('s3cr3t value');
    expect(a).not.toContain('s3cr3t');
  });

  it('binds ciphertext to its context (cannot move a value to another variable or app)', () => {
    const c = box.encrypt('value', 'env:app1:A');
    expect(() => box.decrypt(c, 'env:app1:B')).toThrow();
    expect(() => box.decrypt(c, 'env:app2:A')).toThrow();
  });

  it('detects tampering', () => {
    const c = box.encrypt('value', 'ctx');
    const parts = c.split('.');
    const data = Buffer.from(parts[3]!, 'base64url');
    data[0] = data[0]! ^ 1;
    parts[3] = data.toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'ctx')).toThrow();
  });

  it('supports key rotation: old keys decrypt, new values use the active key', () => {
    const k2 = key();
    const rotated = new SecretBox(`k1:${k1},k2:${k2}`, 'k2');
    const old = box.encrypt('legacy', 'ctx');
    expect(rotated.decrypt(old, 'ctx')).toBe('legacy');
    const re = rotated.rotate(old, 'ctx');
    expect(rotated.keyIdOf(re)).toBe('k2');
    expect(rotated.decrypt(re, 'ctx')).toBe('legacy');
    // After retiring k1, rotated ciphertexts still decrypt.
    const onlyNew = new SecretBox(`k2:${k2}`, 'k2');
    expect(onlyNew.decrypt(re, 'ctx')).toBe('legacy');
    expect(() => onlyNew.decrypt(old, 'ctx')).toThrow(/k1/);
  });

  it('rejects malformed key configuration', () => {
    expect(() => new SecretBox('k1:short', 'k1')).toThrow();
    expect(() => new SecretBox(`k1:${key()}`, 'k2')).toThrow();
    expect(() => new SecretBox('nocolon', 'k1')).toThrow();
  });
});

describe('access tokens', () => {
  const secret = 'x'.repeat(40);
  it('verifies valid tokens and rejects expired or tampered ones', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = signAccessToken({ sid: 's1', uid: 'u1', exp }, secret);
    expect(verifyAccessToken(t, secret)).toEqual({ sid: 's1', uid: 'u1', exp });
    expect(verifyAccessToken(t, 'y'.repeat(40))).toBeNull();
    expect(verifyAccessToken(t, secret, (exp + 1) * 1000)).toBeNull();
    const [body, mac] = t.slice(4).split('.');
    const forged = Buffer.from(JSON.stringify({ sid: 's2', uid: 'u1', exp })).toString('base64url');
    expect(verifyAccessToken(`dfa_${forged}.${mac}`, secret)).toBeNull();
    expect(verifyAccessToken(`dfa_${body}`, secret)).toBeNull();
    expect(verifyAccessToken('garbage', secret)).toBeNull();
  });
  it('compares in constant time and handles different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
