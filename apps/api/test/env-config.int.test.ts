import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createHarness, setupOwner, type BrowserClient, type Harness } from './harness';

let h: Harness;
let owner: BrowserClient;
let app: { id: string };
const SECRET = 'sk_live_very_secret_value_42';

beforeAll(async () => {
  h = await createHarness();
  owner = await setupOwner(h);
  app = await createApp(h, owner, 'envapp', {
    env: [
      { key: 'API_KEY', value: SECRET, secret: true },
      { key: 'GREETING', value: 'hello', secret: false },
      { key: 'NPM_TOKEN', value: 'npm_build_secret_value', scope: 'build', secret: true },
    ],
  });
});
afterAll(async () => h.close());

const post = (p: string, b: object) => owner.agent.post(p).set('x-csrf-token', owner.csrf).send(b);
const put = (p: string, b: object) => owner.agent.put(p).set('x-csrf-token', owner.csrf).send(b);

describe('environment variables', () => {
  it('never returns secret values, only non-secret ones', async () => {
    const res = await owner.agent.get(`/api/apps/${app.id}/env`).expect(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('npm_build_secret_value');
    const byKey = Object.fromEntries(res.body.vars.map((v: { key: string }) => [v.key, v]));
    expect(byKey.API_KEY.value).toBeUndefined();
    expect(byKey.API_KEY.secret).toBe(true);
    expect(byKey.GREETING.value).toBe('hello');
    expect(byKey.NPM_TOKEN.scope).toBe('build');
    // Nor through the application view.
    const view = await owner.agent.get(`/api/apps/${app.id}`).expect(200);
    expect(JSON.stringify(view.body)).not.toContain(SECRET);
  });

  it('stores values encrypted at rest', async () => {
    const revs = await h.prisma.envRevision.findMany({ where: { applicationId: app.id } });
    const raw = JSON.stringify(revs.map((r) => r.entries));
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('hello');
    expect(raw).toContain('df1.k1.');
  });

  it('replaces and deletes without revealing the old value, creating new revisions', async () => {
    const before = (await owner.agent.get(`/api/apps/${app.id}/env`)).body.revision;
    const r1 = await put(`/api/apps/${app.id}/env/API_KEY`, { value: 'rotated-secret-value' }).expect(200);
    expect(r1.body.revision).toBe(before + 1);
    expect(JSON.stringify(r1.body)).not.toContain('rotated-secret-value');
    const r2 = await owner.agent.delete(`/api/apps/${app.id}/env/GREETING`).set('x-csrf-token', owner.csrf).expect(200);
    expect(r2.body.revision).toBe(before + 2);
    expect(r2.body.vars.map((v: { key: string }) => v.key)).not.toContain('GREETING');
    // Earlier revisions are immutable and still decryptable for rollback.
    expect(await h.prisma.envRevision.count({ where: { applicationId: app.id } })).toBe(before + 2);
  });

  it('validates names and rejects duplicates', async () => {
    await post(`/api/apps/${app.id}/env`, { key: '1BAD', value: 'x' }).expect(400);
    await post(`/api/apps/${app.id}/env`, { key: 'BAD-NAME', value: 'x' }).expect(400);
    await post(`/api/apps/${app.id}/env`, { key: 'PORT', value: '1' }).expect(400);
    await post(`/api/apps/${app.id}/env`, { key: 'DEPLOYFORGE_X', value: '1' }).expect(400);
    await post(`/api/apps/${app.id}/env`, { key: 'API_KEY', value: 'dup' }).expect(409);
    const projects = await owner.agent.get(`/api/workspaces/${owner.workspaceId}/projects`);
    await post(`/api/workspaces/${owner.workspaceId}/apps`, {
      projectId: projects.body[0].id,
      name: 'dup',
      slug: 'dup-env',
      source: { type: 'public', repoUrl: 'https://github.com/a/b' },
      env: [
        { key: 'A_VAR', value: '1' },
        { key: 'A_VAR', value: '2' },
      ],
    }).expect(409);
  });

  it('supports optimistic concurrency with expectedRevision', async () => {
    const cur = (await owner.agent.get(`/api/apps/${app.id}/env`)).body.revision;
    await put(`/api/apps/${app.id}/env/API_KEY`, { value: 'v1-value', expectedRevision: cur - 1 }).expect(409);
    await put(`/api/apps/${app.id}/env/API_KEY`, { value: 'v1-value', expectedRevision: cur }).expect(200);
  });

  it('audits changes without recording values', async () => {
    const audit = await owner.agent.get(`/api/workspaces/${owner.workspaceId}/audit?action=env.`).expect(200);
    expect(audit.body.items.length).toBeGreaterThan(0);
    const raw = JSON.stringify(audit.body);
    expect(raw).not.toContain('rotated-secret-value');
    expect(raw).not.toContain('v1-value');
    expect(raw).toContain('API_KEY');
  });

  it('decrypts the right scopes for deployment (build secrets never become build args)', async () => {
    const { EnvService } = await import('../src/applications/env.service');
    const svc = h.app.get(EnvService);
    const a = await h.prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    const resolved = await svc.resolve(a.currentEnvRevisionId!);
    expect(resolved.runtime.API_KEY).toBe('v1-value');
    expect(resolved.buildSecrets).toEqual([{ id: 'NPM_TOKEN', value: 'npm_build_secret_value' }]);
    expect(resolved.buildArgs).toEqual({});
    expect(resolved.secretValues).toContain('npm_build_secret_value');
  });
});

describe('configuration revisions', () => {
  it('snapshots settings immutably and flags pending changes', async () => {
    const v1 = await owner.agent.get(`/api/apps/${app.id}`).expect(200);
    expect(v1.body.configRevision).toBe(1);
    await owner.agent.patch(`/api/apps/${app.id}`).set('x-csrf-token', owner.csrf).send({ port: 8080, healthCheck: { path: '/healthz', timeoutSeconds: 3, intervalSeconds: 2, startPeriodSeconds: 0, retries: 5 } }).expect(200);
    const v2 = await owner.agent.get(`/api/apps/${app.id}`).expect(200);
    expect(v2.body.configRevision).toBe(2);
    const revs = await h.prisma.configRevision.findMany({ where: { applicationId: app.id }, orderBy: { number: 'asc' } });
    expect((revs[0]!.config as { port: number }).port).toBe(3000);
    expect((revs[1]!.config as { port: number }).port).toBe(8080);
    // Renaming does not change the build/runtime config.
    await owner.agent.patch(`/api/apps/${app.id}`).set('x-csrf-token', owner.csrf).send({ name: 'Renamed' }).expect(200);
    expect(await h.prisma.configRevision.count({ where: { applicationId: app.id } })).toBe(2);
  });

  it('records the exact config and env revision on each deployment', async () => {
    const d = await post(`/api/apps/${app.id}/deployments`, {}).expect(201);
    const a = await h.prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    const row = await h.prisma.deployment.findUniqueOrThrow({ where: { id: d.body.id } });
    expect(row.configRevisionId).toBe(a.currentConfigRevisionId);
    expect(row.envRevisionId).toBe(a.currentEnvRevisionId);
    expect(row.commitSha).toBe('a'.repeat(40));
  });

  it('rejects unsafe paths and repository URLs', async () => {
    const projects = await owner.agent.get(`/api/workspaces/${owner.workspaceId}/projects`);
    const base = { projectId: projects.body[0].id, name: 'x', slug: 'unsafe-x' };
    await post(`/api/workspaces/${owner.workspaceId}/apps`, { ...base, source: { type: 'public', repoUrl: 'https://github.com/a/b' }, contextDir: '../..' }).expect(400);
    await post(`/api/workspaces/${owner.workspaceId}/apps`, { ...base, source: { type: 'public', repoUrl: 'https://github.com/a/b' }, dockerfilePath: '/etc/passwd' }).expect(400);
    await post(`/api/workspaces/${owner.workspaceId}/apps`, { ...base, source: { type: 'public', repoUrl: 'file:///etc' } }).expect(422);
    await post(`/api/workspaces/${owner.workspaceId}/apps`, { ...base, source: { type: 'public', repoUrl: 'https://gitlab.com/a/b' } }).expect(422);
    await post(`/api/workspaces/${owner.workspaceId}/apps`, { ...base, slug: 'api', source: { type: 'public', repoUrl: 'https://github.com/a/b' } }).expect(409);
  });
});
