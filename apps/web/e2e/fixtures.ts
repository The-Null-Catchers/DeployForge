import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import http from 'node:http';

export const OWNER = {
  email: process.env.E2E_EMAIL ?? 'owner@example.com',
  password: process.env.E2E_PASSWORD ?? 'correct horse battery',
};
export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
/** Public repository URL of the hermetic git fixture (see scripts/make-fixture-repo.sh). */
export const FIXTURE_REPO = process.env.E2E_REPO_URL ?? 'http://127.0.0.1:8089/demo/sample-app';
export const PROXY = new URL(process.env.E2E_PROXY_URL ?? 'http://127.0.0.1:8080');

export async function ensureOwner(): Promise<void> {
  const api = await request.newContext({ baseURL: BASE });
  const status = await (await api.get('/api/auth/status')).json();
  if (status.setupRequired) {
    const r = await api.post('/api/setup', {
      data: {
        name: 'E2E Owner',
        email: OWNER.email,
        password: OWNER.password,
        workspaceName: 'E2E',
        setupToken: process.env.E2E_SETUP_TOKEN,
      },
      headers: { origin: BASE },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  await api.dispose();
}

/** Tests start signed in (global setup); this just opens the dashboard. */
export async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/w\/[a-z0-9]+/);
}

/** An API client authenticated as the owner (cookie + CSRF), for test setup. */
export async function ownerApi(): Promise<{
  api: APIRequestContext;
  csrf: string;
  workspaceId: string;
}> {
  const api = await request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { origin: BASE },
    storageState: 'test-results/.auth/owner.json',
  });
  const r = await api.get('/api/auth/me');
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  return { api, csrf: body.csrfToken, workspaceId: body.workspaces[0].id };
}

/** GET through Caddy with a Host header (hostnames are *.localhost in dev). */
export function viaProxy(host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: PROXY.hostname, port: PROXY.port || 80, path, headers: { host } },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
  });
}

export function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

export async function fixtureShas(): Promise<Record<string, string>> {
  if (process.env.E2E_SHAS) return JSON.parse(process.env.E2E_SHAS) as Record<string, string>;
  const { readFileSync } = await import('node:fs');
  return JSON.parse(
    readFileSync(new URL('../../../.tmp/fixture/shas.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;
}
