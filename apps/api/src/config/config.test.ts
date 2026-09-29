import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const base = {
  DATABASE_URL: 'postgresql://x@localhost/x',
  SESSION_SECRET: 'a'.repeat(40),
  DEPLOYFORGE_MASTER_KEYS: `k1:${Buffer.alloc(32).toString('base64')}`,
  DEPLOYFORGE_ACTIVE_KEY_ID: 'k1',
  RUNNER_SHARED_SECRET: 'b'.repeat(40),
  PROXY_PROBE_TOKEN: 'c'.repeat(20),
};

describe('configuration', () => {
  it('loads with secure defaults', () => {
    const c = loadConfig(base);
    expect(c.TLS_MODE).toBe('off');
    expect(c.GITHUB_MODE).toBe('disabled');
    expect(c.cookieSecure).toBe(false);
    expect(loadConfig({ ...base, PUBLIC_URL: 'https://d.example.com' }).cookieSecure).toBe(true);
  });
  it('requires strong secrets', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, RUNNER_SHARED_SECRET: undefined })).toThrow(/RUNNER_SHARED_SECRET/);
  });
  it('refuses test-only settings in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', GITHUB_MODE: 'fixture' })).toThrow(/fixture/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', GIT_EXTRA_ALLOWED_HOSTS: 'git-fixture:8080' })).toThrow(/test-only/);
  });
  it('requires ACME email for automatic HTTPS and complete GitHub settings', () => {
    expect(() => loadConfig({ ...base, TLS_MODE: 'acme' })).toThrow(/ACME_EMAIL/);
    expect(() => loadConfig({ ...base, GITHUB_MODE: 'real', GITHUB_APP_ID: '1' })).toThrow(/required/);
  });
});
