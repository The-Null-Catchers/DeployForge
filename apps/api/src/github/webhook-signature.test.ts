import { describe, expect, it } from 'vitest';
import { signGithubPayload, verifyGithubSignature } from './webhook-signature';

describe('GitHub webhook signature', () => {
  const secret = 'webhook-secret-value';
  const body = Buffer.from('{"ref":"refs/heads/main","after":"abc"}');

  it('accepts a correct signature over the raw body', () => {
    expect(verifyGithubSignature(secret, body, signGithubPayload(secret, body))).toBe(true);
  });
  it('rejects a modified body (even semantically identical JSON)', () => {
    const reformatted = Buffer.from('{ "ref": "refs/heads/main", "after": "abc" }');
    expect(verifyGithubSignature(secret, reformatted, signGithubPayload(secret, body))).toBe(false);
  });
  it('rejects wrong secret, missing header, bad prefix and bad length', () => {
    expect(verifyGithubSignature('other', body, signGithubPayload(secret, body))).toBe(false);
    expect(verifyGithubSignature(secret, body, undefined)).toBe(false);
    expect(verifyGithubSignature(secret, body, signGithubPayload(secret, body).replace('sha256=', 'sha1='))).toBe(false);
    expect(verifyGithubSignature(secret, body, 'sha256=abcd')).toBe(false);
    expect(verifyGithubSignature('', body, signGithubPayload('', body))).toBe(false);
  });
});
