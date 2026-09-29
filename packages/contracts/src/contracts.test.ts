import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  REDACTED,
  StreamRedactor,
  assertTransition,
  buildRequestSchema,
  buildStatusSchema,
  can,
  canTransition,
  checkRelativePath,
  containerCreateRequestSchema,
  containerStatsSchema,
  createApplicationRequestSchema,
  envNameSchema,
  hostnameSchema,
  isCancelable,
  parseRepoUrl,
  permissionsFor,
  probeResultSchema,
  redactAll,
  redactionNeedles,
  relativePathSchema,
  runnerHealthSchema,
  slugSchema,
} from './index';

describe('permission matrix', () => {
  it('lets owners do everything', () => {
    expect(can('owner', 'members.manage')).toBe(true);
    expect(can('owner', 'app.delete')).toBe(true);
  });
  it('lets developers manage apps and deployments but not members or deletion', () => {
    expect(can('developer', 'deployment.create')).toBe(true);
    expect(can('developer', 'deployment.rollback')).toBe(true);
    expect(can('developer', 'env.write')).toBe(true);
    expect(can('developer', 'members.manage')).toBe(false);
    expect(can('developer', 'app.delete')).toBe(false);
    expect(can('developer', 'github.connect')).toBe(false);
  });
  it('restricts viewers to read-only access', () => {
    const perms = permissionsFor('viewer');
    expect(perms.every((p) => p.endsWith('.read'))).toBe(true);
    expect(can('viewer', 'deployment.create')).toBe(false);
    expect(can('viewer', 'env.write')).toBe(false);
    expect(can('viewer', 'audit.read')).toBe(false);
  });
  it('denies unknown roles', () => {
    expect(can(null, 'app.read')).toBe(false);
    expect(can(undefined, 'app.read')).toBe(false);
  });
});

describe('deployment state machine', () => {
  it('follows the happy path', () => {
    const path = ['queued', 'preparing', 'cloning', 'building', 'starting', 'checking_health', 'promoting', 'succeeded'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });
  it('lets rollbacks skip the build', () => {
    expect(canTransition('preparing', 'starting')).toBe(true);
  });
  it('forbids leaving terminal states', () => {
    for (const s of ['succeeded', 'failed', 'canceled', 'interrupted'] as const) {
      expect(canTransition(s, 'queued')).toBe(false);
      expect(canTransition(s, 'promoting')).toBe(false);
    }
  });
  it('forbids cancellation after the promotion boundary', () => {
    expect(isCancelable('checking_health')).toBe(true);
    expect(isCancelable('promoting')).toBe(false);
    expect(() => assertTransition('promoting', 'canceled')).toThrow();
  });
  it('forbids skipping stages backwards', () => {
    expect(canTransition('building', 'cloning')).toBe(false);
    expect(canTransition('queued', 'succeeded')).toBe(false);
  });
});

describe('configuration validation', () => {
  it('rejects path traversal and absolute paths', () => {
    expect(checkRelativePath('../etc')).not.toBeNull();
    expect(checkRelativePath('a/../../b')).not.toBeNull();
    expect(checkRelativePath('/etc/passwd')).not.toBeNull();
    expect(checkRelativePath('a\\b')).not.toBeNull();
    expect(checkRelativePath('a\u0000b')).not.toBeNull();
    expect(checkRelativePath('services/web/Dockerfile')).toBeNull();
  });
  it('normalizes relative paths', () => {
    expect(relativePathSchema.parse('./')).toBe('.');
    expect(relativePathSchema.parse('./app//web/')).toBe('app/web');
  });
  it('validates env names', () => {
    expect(envNameSchema.safeParse('DATABASE_URL').success).toBe(true);
    expect(envNameSchema.safeParse('1BAD').success).toBe(false);
    expect(envNameSchema.safeParse('HAS-DASH').success).toBe(false);
    expect(envNameSchema.safeParse('DEPLOYFORGE_X').success).toBe(false);
    expect(envNameSchema.safeParse('PORT').success).toBe(false);
  });
  it('validates slugs and hostnames', () => {
    expect(slugSchema.safeParse('my-app').success).toBe(true);
    expect(slugSchema.safeParse('My-App').success).toBe(false);
    expect(slugSchema.safeParse('a--b').success).toBe(false);
    expect(hostnameSchema.safeParse('app.example.com').success).toBe(true);
    expect(hostnameSchema.safeParse('*.example.com').success).toBe(false);
    expect(hostnameSchema.safeParse('localhost').success).toBe(false);
    expect(hostnameSchema.safeParse('exa mple.com').success).toBe(false);
  });
  it('only accepts https GitHub repositories', () => {
    expect(parseRepoUrl('https://github.com/acme/web')?.cloneUrl).toBe('https://github.com/acme/web.git');
    expect(parseRepoUrl('https://github.com/acme/web.git')?.fullName).toBe('acme/web');
    expect(parseRepoUrl('http://github.com/acme/web')).toBeNull();
    expect(parseRepoUrl('https://user:pw@github.com/acme/web')).toBeNull();
    expect(parseRepoUrl('https://gitlab.com/acme/web')).toBeNull();
    expect(parseRepoUrl('file:///etc')).toBeNull();
    expect(parseRepoUrl('https://github.com/acme/web/../../x')).toBeNull();
    expect(parseRepoUrl('ext::sh -c touch% /tmp/pwned')).toBeNull();
    expect(parseRepoUrl('https://github.com/-acme/web')).toBeNull();
  });
  it('accepts the fixture host only when explicitly allowed', () => {
    expect(parseRepoUrl('http://git-fixture:8080/demo/sample')).toBeNull();
    expect(parseRepoUrl('http://git-fixture:8080/demo/sample', ['git-fixture:8080'])?.cloneUrl).toBe(
      'http://git-fixture:8080/demo/sample.git',
    );
  });
  it('applies defaults when creating an application', () => {
    const parsed = createApplicationRequestSchema.parse({
      projectId: 'p1',
      name: 'Web',
      slug: 'web',
      source: { type: 'public', repoUrl: 'https://github.com/acme/web' },
    });
    expect(parsed.port).toBe(3000);
    expect(parsed.dockerfilePath).toBe('Dockerfile');
    expect(parsed.healthCheck.path).toBe('/');
    expect(parsed.autoDeploy).toBe(false);
  });
});

describe('redaction', () => {
  const secret = 'sk_live_abcdef123456';
  it('redacts full occurrences', () => {
    expect(redactAll(`token=${secret}!`, redactionNeedles([secret]))).toBe(`token=${REDACTED}!`);
  });
  it('ignores very short secrets', () => {
    expect(redactionNeedles(['abc'])).toEqual([]);
  });
  it('redacts secrets split across chunk boundaries', () => {
    const r = new StreamRedactor([secret]);
    const text = `start ${secret} middle ${secret} end`;
    // Split into every possible pair of chunks
    for (let i = 0; i <= text.length; i++) {
      const r2 = new StreamRedactor([secret]);
      const out = r2.push(text.slice(0, i)) + r2.push(text.slice(i)) + r2.flush();
      expect(out).toBe(`start ${REDACTED} middle ${REDACTED} end`);
    }
    // One character at a time
    let out = '';
    for (const ch of text) out += r.push(ch);
    out += r.flush();
    expect(out).not.toContain(secret);
    expect(out).toBe(`start ${REDACTED} middle ${REDACTED} end`);
  });
  it('emits text that cannot be a secret prefix immediately', () => {
    const r = new StreamRedactor([secret]);
    expect(r.push('hello world\n')).toBe('hello world\n');
    expect(r.push('prefix sk_li')).toBe('prefix ');
    expect(r.push('ve_nope')).toBe('sk_live_nope');
  });
  it('redacts each line of multi-line secrets and URL-encoded forms', () => {
    const pem = '-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34\n-----END KEY-----';
    const needles = redactionNeedles([pem, 'p@ss w0rd/x']);
    expect(redactAll('line MIIBOgIBAAJBAKj34 here', needles)).toBe(`line ${REDACTED} here`);
    expect(redactAll('url=p%40ss%20w0rd%2Fx', needles)).toBe(`url=${REDACTED}`);
  });
});

describe('runner protocol fixtures', () => {
  const dir = join(__dirname, '..', 'fixtures', 'runner-v1');
  const schemas: Record<string, { parse: (v: unknown) => unknown }> = {
    'health.json': runnerHealthSchema,
    'build-request.json': buildRequestSchema,
    'build-status.json': buildStatusSchema,
    'container-create-request.json': containerCreateRequestSchema,
    'probe-result.json': probeResultSchema,
    'container-stats.json': containerStatsSchema,
  };
  it('has a schema for every fixture', () => {
    for (const f of readdirSync(dir)) expect(schemas[f], f).toBeDefined();
  });
  for (const [file, schema] of Object.entries(schemas)) {
    it(`validates ${file}`, () => {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      expect(() => schema.parse(data)).not.toThrow();
    });
  }
});
