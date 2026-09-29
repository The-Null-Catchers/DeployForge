import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RunnerClient, RunnerError } from '../src/runner/runner.client';
import type { AppConfig } from '../src/config/config';

/**
 * Cross-language check: the TypeScript client's HMAC signatures are accepted
 * by the real Go runner binary, and wrong secrets or tampering are rejected.
 */
const runnerDir = resolve(__dirname, '..', '..', '..', 'services', 'runner');
const bin = join(runnerDir, 'bin', 'runner');
const secret = 'integration-runner-secret-0123456789abcdef';
let proc: ChildProcess;
const port = 17070 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  execFileSync('go', ['build', '-o', bin, './cmd/runner'], { cwd: runnerDir, stdio: 'pipe' });
  proc = spawn(bin, [], {
    env: { ...process.env, RUNNER_SHARED_SECRET: secret, RUNNER_LISTEN: `127.0.0.1:${port}`, RUNNER_WORK_DIR: mkdtempSync(join(tmpdir(), 'df-runner-')) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.status === 204) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('runner did not start');
}, 120_000);

afterAll(() => {
  proc?.kill();
});

const client = (s: string) => new RunnerClient({ RUNNER_URL: `http://127.0.0.1:${port}`, RUNNER_SHARED_SECRET: s } as AppConfig);

describe('runner authentication (TypeScript client ↔ Go runner)', () => {
  it('accepts correctly signed requests', async () => {
    expect(existsSync(bin)).toBe(true);
    const h = await client(secret).health();
    expect(h.protocolVersion).toBe(1);
  });

  it('rejects requests signed with the wrong secret', async () => {
    await expect(client('x'.repeat(40)).health()).rejects.toMatchObject({ status: 401 });
  });

  it('rejects unsigned and replayed requests', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/v1/health`)).status).toBe(401);
    const c = client(secret) as unknown as { sign(m: string, p: string, b: string): Record<string, string> };
    const headers = c.sign('GET', '/v1/health', '');
    expect((await fetch(`http://127.0.0.1:${port}/v1/health`, { headers })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/v1/health`, { headers })).status).toBe(401);
  });

  it('rejects a signature for a different path or body', async () => {
    const c = client(secret) as unknown as { sign(m: string, p: string, b: string): Record<string, string> };
    const headers = c.sign('GET', '/v1/images', '');
    expect((await fetch(`http://127.0.0.1:${port}/v1/containers`, { headers })).status).toBe(401);
    const post = c.sign('POST', '/v1/networks', '{"workspaceId":"a"}');
    const r = await fetch(`http://127.0.0.1:${port}/v1/networks`, { method: 'POST', headers: { ...post, 'content-type': 'application/json' }, body: '{"workspaceId":"b"}' });
    expect(r.status).toBe(401);
  });

  it('classifies unreachable runners as retryable', async () => {
    const dead = new RunnerClient({ RUNNER_URL: 'http://127.0.0.1:1', RUNNER_SHARED_SECRET: secret } as AppConfig);
    const err = await dead.request('GET', '/v1/health', undefined, { retries: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerError);
    expect((err as RunnerError).retryable).toBe(true);
  });
});
