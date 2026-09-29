import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for secrets at rest (AES-256-GCM, Node's OpenSSL
 * binding). Master keys come from the environment, never the database:
 *
 *   DEPLOYFORGE_MASTER_KEYS=k1:<base64 32 bytes>,k2:<base64 32 bytes>
 *   DEPLOYFORGE_ACTIVE_KEY_ID=k2
 *
 * New values are encrypted with the active key; older keys remain available
 * for decryption until `pnpm --filter @deployforge/api rotate-keys` has
 * re-encrypted everything. Each ciphertext is bound to its context (e.g.
 * application ID + variable name) through AES-GCM additional data, so a
 * ciphertext cannot be moved to another variable or application.
 *
 * Format: df1.<keyId>.<iv b64url>.<ciphertext||tag b64url>
 */
export class SecretBox {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    spec: string,
    private readonly activeKeyId: string,
  ) {
    for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const idx = part.indexOf(':');
      if (idx <= 0) throw new Error('DEPLOYFORGE_MASTER_KEYS entries must look like <id>:<base64 key>');
      const id = part.slice(0, idx);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`Invalid master key id ${id}`);
      const raw = Buffer.from(part.slice(idx + 1), 'base64');
      if (raw.length !== 32) throw new Error(`Master key ${id} must decode to exactly 32 bytes`);
      // Derive a purpose-specific key so the raw master key is never used directly.
      this.keys.set(id, Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), 'deployforge/secret-box/v1', 32)));
    }
    if (!this.keys.has(activeKeyId)) throw new Error(`Active key ${activeKeyId} is not present in DEPLOYFORGE_MASTER_KEYS`);
  }

  get activeKey(): string {
    return this.activeKeyId;
  }

  keyIdOf(ciphertext: string): string | null {
    const parts = ciphertext.split('.');
    return parts.length === 4 && parts[0] === 'df1' ? parts[1]! : null;
  }

  encrypt(plaintext: string, context: string): string {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return ['df1', this.activeKeyId, iv.toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(ciphertext: string, context: string): string {
    const parts = ciphertext.split('.');
    if (parts.length !== 4 || parts[0] !== 'df1') throw new Error('Unsupported ciphertext format');
    const key = this.keys.get(parts[1]!);
    if (!key) throw new Error(`Master key ${parts[1]} is not configured; cannot decrypt`);
    const iv = Buffer.from(parts[2]!, 'base64url');
    const data = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== 12 || data.length < 16) throw new Error('Corrupt ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
  }

  /** Re-encrypt under the active key (used by key rotation). */
  rotate(ciphertext: string, context: string): string {
    if (this.keyIdOf(ciphertext) === this.activeKeyId) return ciphertext;
    return this.encrypt(this.decrypt(ciphertext, context), context);
  }
}
