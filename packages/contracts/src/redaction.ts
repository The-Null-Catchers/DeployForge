/**
 * Best-effort secret redaction for build and runtime logs.
 *
 * Redaction is applied before logs are persisted or streamed. It catches the
 * literal secret (and its URL-encoded form), including when a secret is split
 * across chunk boundaries. It cannot catch secrets that a build step
 * transforms (base64, hex, reversed, printed one character per line...). The
 * trust model therefore still treats anyone who controls a Dockerfile as able
 * to exfiltrate secrets that the build receives.
 */
export const REDACTED = '[REDACTED]';
/** Very short values would redact ordinary text; they are not redacted. */
export const MIN_REDACT_LENGTH = 6;

export function redactionNeedles(secrets: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const raw of secrets) {
    if (!raw) continue;
    const candidates = [raw, ...raw.split(/\r?\n/)];
    for (const c of candidates) {
      const v = c.trim();
      if (v.length < MIN_REDACT_LENGTH) continue;
      out.add(v);
      const enc = encodeURIComponent(v);
      if (enc !== v) out.add(enc);
    }
  }
  // Longest first so that a secret containing another secret is fully masked.
  return [...out].sort((a, b) => b.length - a.length);
}

export function redactAll(text: string, needles: readonly string[]): string {
  let out = text;
  for (const n of needles) {
    if (out.includes(n)) out = out.split(n).join(REDACTED);
  }
  return out;
}

/**
 * Streaming redactor. `push` returns text that is safe to emit; a suffix that
 * could be the beginning of a secret is held back until more data (or
 * `flush`) proves otherwise.
 */
export class StreamRedactor {
  private readonly needles: string[];
  private buffer = '';

  constructor(secrets: Iterable<string>) {
    this.needles = redactionNeedles(secrets);
  }

  get active(): boolean {
    return this.needles.length > 0;
  }

  push(chunk: string): string {
    if (this.needles.length === 0) return chunk;
    this.buffer = redactAll(this.buffer + chunk, this.needles);
    const hold = this.partialSuffixLength(this.buffer);
    const emit = this.buffer.slice(0, this.buffer.length - hold);
    this.buffer = this.buffer.slice(this.buffer.length - hold);
    return emit;
  }

  flush(): string {
    const out = redactAll(this.buffer, this.needles);
    this.buffer = '';
    return out;
  }

  /** Length of the longest buffer suffix that is a proper prefix of a needle. */
  private partialSuffixLength(buf: string): number {
    let best = 0;
    for (const n of this.needles) {
      const max = Math.min(n.length - 1, buf.length);
      for (let k = max; k > best; k--) {
        if (buf.endsWith(n.slice(0, k))) {
          best = k;
          break;
        }
      }
    }
    return best;
  }
}
