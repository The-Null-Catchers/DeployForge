import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { canonicalRequest } from '@deployforge/contracts';

/**
 * In-process stand-in for the runner used by API integration tests that do
 * not need Docker. It verifies HMAC signatures exactly like the Go runner and
 * records requests. Real Docker behavior is covered by the runner's own
 * Docker tests and the acceptance suite, never by this fake.
 */
export class FakeRunner {
  server: http.Server;
  url = '';
  requests: { method: string; path: string; body: unknown }[] = [];
  branches = new Map<string, string>([['main', 'a'.repeat(40)]]);
  unauthorized = 0;

  constructor(private readonly secret: string) {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks)));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private verify(req: http.IncomingMessage, body: Buffer): boolean {
    const ts = String(req.headers['x-deployforge-timestamp'] ?? '');
    const nonce = String(req.headers['x-deployforge-nonce'] ?? '');
    const sig = String(req.headers['x-deployforge-signature'] ?? '');
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const expected = 'v1=' + createHmac('sha256', this.secret).update(canonicalRequest(req.method!, req.url!, ts, nonce, bodyHash)).digest('hex');
    return req.headers['x-deployforge-protocol'] === '1' && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (!this.verify(req, body)) {
      this.unauthorized++;
      return json(401, { code: 'unauthorized', message: 'bad signature', retryable: false });
    }
    const parsed = body.length ? (JSON.parse(body.toString()) as Record<string, unknown>) : undefined;
    this.requests.push({ method: req.method!, path: req.url!, body: parsed });
    if (req.url === '/v1/git/resolve') {
      const sha = this.branches.get(String(parsed?.branch));
      return json(200, { commitSha: sha ?? '', found: !!sha });
    }
    if (req.url === '/v1/health') {
      return json(200, { ok: true, protocolVersion: 1, runnerVersion: 'fake', docker: { ok: true, version: 'fake' }, buildx: { ok: true, version: 'fake' }, activeBuilds: 0, maxConcurrentBuilds: 1 });
    }
    if (req.url?.startsWith('/v1/images') || req.url?.startsWith('/v1/containers')) return json(200, []);
    return json(404, { code: 'not_found', message: 'not implemented in fake', retryable: false });
  }
}
