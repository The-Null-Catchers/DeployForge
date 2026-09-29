import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { addMember, createHarness, fixtureData, resetDatabase, setupOwner, WEBHOOK_SECRET, type BrowserClient, type Harness } from './harness';
import { signGithubPayload } from '../src/github/webhook-signature';
import { WebhookProcessor } from '../src/github/webhook.processor';

let h: Harness;
let owner: BrowserClient;

beforeAll(async () => {
  h = await createHarness();
  h.github.setData(fixtureData());
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDatabase(h.prisma);
  await h.redis.client.flushdb();
  owner = await setupOwner(h);
});

/** Run the connect flow the way a browser would: start, "install" on GitHub, callback. */
async function connect(client: BrowserClient, installationId = 1001, code = 'fixture-code') {
  const start = await client.agent.post(`/api/workspaces/${client.workspaceId}/github/connect`).set('x-csrf-token', client.csrf).send({}).expect(201);
  const state = new URL(start.body.url, 'http://x').searchParams.get('state')!;
  const res = await client.agent.get(`/api/github/setup?installation_id=${installationId}&setup_action=install&state=${state}&code=${code}`);
  expect(res.status).toBe(302);
  return res;
}

async function githubApp(client: BrowserClient, extra: Record<string, unknown> = {}) {
  await connect(client);
  const inst = (await client.agent.get(`/api/workspaces/${client.workspaceId}/github/installations`).expect(200)).body[0];
  const projects = await client.agent.get(`/api/workspaces/${client.workspaceId}/projects`);
  const app = await client.agent
    .post(`/api/workspaces/${client.workspaceId}/apps`)
    .set('x-csrf-token', client.csrf)
    .send({ projectId: projects.body[0].id, name: 'gh', slug: 'gh-app', source: { type: 'github', installationId: inst.id, repositoryId: 555 }, branch: 'main', autoDeploy: true, ...extra })
    .expect(201);
  return { inst, app: app.body };
}

function send(event: string, payload: object, opts: { delivery?: string; secret?: string; signature?: string } = {}) {
  const body = JSON.stringify(payload);
  return h.http
    .post('/api/github/webhooks')
    .set('content-type', 'application/json')
    .set('x-github-event', event)
    .set('x-github-delivery', opts.delivery ?? randomUUID())
    .set('x-hub-signature-256', opts.signature ?? signGithubPayload(opts.secret ?? WEBHOOK_SECRET, body))
    .send(body);
}

const push = (over: Record<string, unknown> = {}) => ({
  ref: 'refs/heads/main',
  after: 'b'.repeat(40),
  deleted: false,
  repository: { id: 555, full_name: 'acme/private-app' },
  installation: { id: 1001 },
  head_commit: { message: 'Fix things\n\nlong body' },
  ...over,
});

describe('GitHub App installation flow', () => {
  it('binds an installation only with valid state and OAuth proof of access', async () => {
    const res = await connect(owner);
    expect(res.headers.location).toContain('github=connected');
    const list = await owner.agent.get(`/api/workspaces/${owner.workspaceId}/github/installations`).expect(200);
    expect(list.body).toMatchObject([{ githubInstallationId: 1001, accountLogin: 'acme', status: 'active' }]);
  });

  it('rejects reused or forged state', async () => {
    const start = await owner.agent.post(`/api/workspaces/${owner.workspaceId}/github/connect`).set('x-csrf-token', owner.csrf).send({}).expect(201);
    const state = new URL(start.body.url, 'http://x').searchParams.get('state')!;
    await owner.agent.get(`/api/github/setup?installation_id=1001&state=${state}&code=fixture-code`).expect(302);
    const reused = await owner.agent.get(`/api/github/setup?installation_id=1001&state=${state}&code=fixture-code`).expect(302);
    expect(reused.headers.location).toContain('invalid_state');
    const forged = await owner.agent.get('/api/github/setup?installation_id=1001&state=forged&code=fixture-code').expect(302);
    expect(forged.headers.location).toContain('invalid_state');
  });

  it('refuses to bind an installation the GitHub user cannot access (guessed installation_id)', async () => {
    const res = await connect(owner, 2002, 'fixture-code');
    expect(res.headers.location).toContain('installation_not_accessible');
    expect(await h.prisma.githubInstallation.count()).toBe(0);
  });

  it('refuses to bind the same installation to a second workspace', async () => {
    await connect(owner);
    const ws = await owner.agent.post('/api/workspaces').set('x-csrf-token', owner.csrf).send({ name: 'Second' }).expect(201);
    const other = { ...owner, workspaceId: ws.body.id };
    const res = await connect(other);
    expect(res.headers.location).toContain('bound_to_another_workspace');
  });

  it('requires the owner role to start connecting', async () => {
    const dev = await addMember(h, owner, 'dev@example.com', 'developer');
    await dev.agent.post(`/api/workspaces/${owner.workspaceId}/github/connect`).set('x-csrf-token', dev.csrf).send({}).expect(403);
  });

  it('lists repositories with pagination and branches through the installation', async () => {
    await connect(owner);
    const inst = (await owner.agent.get(`/api/workspaces/${owner.workspaceId}/github/installations`)).body[0];
    const repos = await owner.agent.get(`/api/github/installations/${inst.id}/repos?page=1`).expect(200);
    expect(repos.body.total).toBe(2);
    expect(repos.body.items.map((r: { fullName: string }) => r.fullName)).toContain('acme/private-app');
    const branches = await owner.agent.get(`/api/github/installations/${inst.id}/branches?repositoryId=555`).expect(200);
    expect(branches.body.items).toEqual(['main', 'develop']);
  });

  it('never exposes installation tokens to clients', async () => {
    const { app } = await githubApp(owner);
    h.runner.requests = [];
    await owner.agent.post(`/api/apps/${app.id}/deployments`).set('x-csrf-token', owner.csrf).send({}).expect(201);
    const bodies = await Promise.all([
      owner.agent.get(`/api/apps/${app.id}`),
      owner.agent.get(`/api/workspaces/${owner.workspaceId}/github/installations`),
      owner.agent.get(`/api/apps/${app.id}/deployments`),
    ]);
    for (const b of bodies) expect(JSON.stringify(b.body)).not.toContain('ghs_fixture_installation_token_value');
    // Only the runner received it (to resolve/clone the repository).
    const resolveReq = h.runner.requests.find((r) => r.path === '/v1/git/resolve');
    expect(resolveReq?.body).toMatchObject({ auth: { username: 'x-access-token', token: 'ghs_fixture_installation_token_value' } });
    expect(JSON.stringify(await h.prisma.deployment.findMany())).not.toContain('ghs_fixture');
  });
});

describe('webhooks', () => {
  it('rejects invalid signatures and does not store the delivery', async () => {
    await send('push', push(), { secret: 'wrong' }).expect(403);
    await send('push', push(), { signature: 'sha256=00' }).expect(403);
    expect(await h.prisma.webhookDelivery.count()).toBe(0);
  });

  it('acknowledges quickly, stores the delivery and enqueues durably', async () => {
    const id = randomUUID();
    await send('push', push(), { delivery: id }).expect(202);
    expect(await h.prisma.webhookDelivery.findUnique({ where: { id } })).toMatchObject({ event: 'push', status: 'queued' });
    expect(await h.prisma.outboxEvent.count({ where: { kind: 'webhook.process' } })).toBe(1);
  });

  it('deduplicates redelivered webhooks by delivery ID', async () => {
    const id = randomUUID();
    await send('push', push(), { delivery: id }).expect(202);
    const again = await send('push', push(), { delivery: id }).expect(202);
    expect(again.body.duplicate).toBe(true);
    expect(await h.prisma.outboxEvent.count({ where: { kind: 'webhook.process' } })).toBe(1);
  });

  it('deploys the exact pushed commit for matching auto-deploy apps', async () => {
    const { app } = await githubApp(owner);
    const id = randomUUID();
    await send('push', push(), { delivery: id }).expect(202);
    await h.app.get(WebhookProcessor).process(id);
    const deps = await h.prisma.deployment.findMany({ where: { applicationId: app.id } });
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ trigger: 'push', commitSha: 'b'.repeat(40), commitMessage: 'Fix things', actorId: null });
    // Processing the same delivery again is a no-op.
    await h.prisma.webhookDelivery.update({ where: { id }, data: { processedAt: null } });
    await h.app.get(WebhookProcessor).process(id);
    expect(await h.prisma.deployment.count({ where: { applicationId: app.id } })).toBe(1);
  });

  it('ignores pushes whose installation, repository or branch do not match', async () => {
    const { app } = await githubApp(owner);
    const cases = [push({ repository: { id: 999 } }), push({ installation: { id: 2002 } }), push({ ref: 'refs/heads/develop' }), push({ ref: 'refs/tags/v1' })];
    for (const p of cases) {
      const id = randomUUID();
      await send('push', p, { delivery: id }).expect(202);
      await h.app.get(WebhookProcessor).process(id);
    }
    expect(await h.prisma.deployment.count({ where: { applicationId: app.id } })).toBe(0);
  });

  it('does not deploy when auto-deploy is off', async () => {
    const { app } = await githubApp(owner, { autoDeploy: false });
    const id = randomUUID();
    await send('push', push(), { delivery: id }).expect(202);
    await h.app.get(WebhookProcessor).process(id);
    expect(await h.prisma.deployment.count({ where: { applicationId: app.id } })).toBe(0);
  });

  it('marks deleted branches, removed repository access and uninstalled apps', async () => {
    const { app } = await githubApp(owner);
    const del = randomUUID();
    await send('push', push({ deleted: true, after: '0'.repeat(40) }), { delivery: del }).expect(202);
    await h.app.get(WebhookProcessor).process(del);
    expect((await h.prisma.application.findUniqueOrThrow({ where: { id: app.id } })).sourceStatus).toBe('branch_deleted');
    expect(await h.prisma.deployment.count()).toBe(0);

    const rem = randomUUID();
    await send('installation_repositories', { action: 'removed', installation: { id: 1001 }, repositories_removed: [{ id: 555 }], repositories_added: [] }, { delivery: rem }).expect(202);
    await h.app.get(WebhookProcessor).process(rem);
    expect((await h.prisma.application.findUniqueOrThrow({ where: { id: app.id } })).sourceStatus).toBe('access_removed');

    const un = randomUUID();
    await send('installation', { action: 'deleted', installation: { id: 1001 } }, { delivery: un }).expect(202);
    await h.app.get(WebhookProcessor).process(un);
    expect((await h.prisma.application.findUniqueOrThrow({ where: { id: app.id } })).sourceStatus).toBe('installation_disconnected');
    // Pushes to a disconnected installation are ignored.
    const p = randomUUID();
    await send('push', push(), { delivery: p }).expect(202);
    await h.app.get(WebhookProcessor).process(p);
    expect(await h.prisma.deployment.count()).toBe(0);
    // Manual deploys explain the problem.
    const r = await owner.agent.post(`/api/apps/${app.id}/deployments`).set('x-csrf-token', owner.csrf).send({}).expect(422);
    expect(r.body.code).toBe('installation_disconnected');
  });
});
