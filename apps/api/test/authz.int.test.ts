import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addMember, createApp, createHarness, PASSWORD, setupOwner, type BrowserClient, type Harness } from './harness';

/**
 * Workspace isolation and the role matrix, enforced server-side. Every
 * request below is made directly against the API; nothing relies on the UI
 * hiding controls.
 */
let h: Harness;
let owner: BrowserClient; // owner of workspace Alpha
let dev: BrowserClient; // developer in Alpha
let viewer: BrowserClient; // viewer in Alpha
let outsider: BrowserClient; // owner of workspace Beta only
let app: { id: string };
let deploymentId: string;
let domainId: string;
let betaApp: { id: string };

beforeAll(async () => {
  h = await createHarness();
  owner = await setupOwner(h);
  dev = await addMember(h, owner, 'dev@example.com', 'developer');
  viewer = await addMember(h, owner, 'viewer@example.com', 'viewer');
  app = await createApp(h, owner, 'alpha-web', { env: [{ key: 'SECRET_TOKEN', value: 'alpha-secret-value', secret: true }] });

  // Workspace Beta, owned by someone else (created by the instance admin, who then leaves).
  const ws = await owner.agent.post('/api/workspaces').set('x-csrf-token', owner.csrf).send({ name: 'Beta' }).expect(201);
  outsider = await addMember(h, owner, 'beta-owner@example.com', 'owner', ws.body.id);
  await outsider.agent.delete(`/api/workspaces/${ws.body.id}/members/${owner.userId}`).set('x-csrf-token', outsider.csrf).expect(204);
  outsider.workspaceId = ws.body.id;
  betaApp = await createApp(h, outsider, 'beta-web');

  const d = await owner.agent.post(`/api/apps/${app.id}/deployments`).set('x-csrf-token', owner.csrf).send({}).expect(201);
  deploymentId = d.body.id;
  const dom = await owner.agent.post(`/api/apps/${app.id}/domains`).set('x-csrf-token', owner.csrf).send({ hostname: 'www.alpha-example.com' }).expect(201);
  domainId = dom.body.id;
});

afterAll(async () => {
  await h.close();
});

const as = (c: BrowserClient) => ({
  get: (p: string) => c.agent.get(p),
  post: (p: string, body: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(body),
  put: (p: string, body: object = {}) => c.agent.put(p).set('x-csrf-token', c.csrf).send(body),
  patch: (p: string, body: object = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(body),
  del: (p: string, body: object = {}) => c.agent.delete(p).set('x-csrf-token', c.csrf).send(body),
});

describe('cross-workspace isolation', () => {
  it('returns 404 (not 403) for every resource of another workspace', async () => {
    const o = as(outsider);
    const checks = [
      o.get(`/api/apps/${app.id}`),
      o.get(`/api/apps/${app.id}/deployments`),
      o.get(`/api/deployments/${deploymentId}`),
      o.get(`/api/deployments/${deploymentId}/logs`),
      o.get(`/api/deployments/${deploymentId}/events`),
      o.get(`/api/deployments/${deploymentId}/stream`),
      o.get(`/api/deployments/${deploymentId}/logs/download`),
      o.get(`/api/apps/${app.id}/env`),
      o.get(`/api/apps/${app.id}/domains`),
      o.get(`/api/apps/${app.id}/metrics`),
      o.get(`/api/apps/${app.id}/runtime-logs`),
      o.get(`/api/workspaces/${owner.workspaceId}/projects`),
      o.get(`/api/workspaces/${owner.workspaceId}/members`),
      o.get(`/api/workspaces/${owner.workspaceId}/audit`),
      o.post(`/api/apps/${app.id}/deployments`),
      o.post(`/api/apps/${app.id}/env`, { key: 'X_VAR', value: 'v' }),
      o.put(`/api/apps/${app.id}/env/SECRET_TOKEN`, { value: 'stolen' }),
      o.del(`/api/apps/${app.id}/env/SECRET_TOKEN`),
      o.patch(`/api/apps/${app.id}`, { port: 8080 }),
      o.post(`/api/apps/${app.id}/stop`),
      o.del(`/api/apps/${app.id}`, { confirmSlug: 'alpha-web' }),
      o.post(`/api/deployments/${deploymentId}/cancel`),
      o.post(`/api/deployments/${deploymentId}/rollback`, { confirm: true }),
      o.post(`/api/domains/${domainId}/verify`),
      o.del(`/api/domains/${domainId}`),
      o.post(`/api/workspaces/${owner.workspaceId}/invites`, { email: 'x@example.com', role: 'owner' }),
    ];
    for (const res of await Promise.all(checks)) {
      expect(res.status, `${res.req.method} ${res.req.path}`).toBe(404);
    }
    // And nothing changed.
    const env = await as(owner).get(`/api/apps/${app.id}/env`).expect(200);
    expect(env.body.vars.map((v: { key: string }) => v.key)).toEqual(['SECRET_TOKEN']);
  });

  it('cannot create an app in another workspace or use another workspace project', async () => {
    const projects = await as(owner).get(`/api/workspaces/${owner.workspaceId}/projects`).expect(200);
    await as(outsider).post(`/api/workspaces/${owner.workspaceId}/apps`, { projectId: projects.body[0].id, name: 'x', slug: 'xx-app', source: { type: 'public', repoUrl: 'https://github.com/a/b' } }).expect(404);
    // Own workspace but foreign project id.
    await as(outsider).post(`/api/workspaces/${outsider.workspaceId}/apps`, { projectId: projects.body[0].id, name: 'x', slug: 'xy-app', source: { type: 'public', repoUrl: 'https://github.com/a/b' } }).expect(404);
  });

  it('does not list other workspaces', async () => {
    const list = await as(outsider).get('/api/workspaces').expect(200);
    expect(list.body.map((w: { id: string }) => w.id)).toEqual([outsider.workspaceId]);
    await as(owner).get(`/api/apps/${betaApp.id}`).expect(404);
  });
});

describe('role matrix', () => {
  it('viewers can read status and logs but cannot change anything', async () => {
    const v = as(viewer);
    await v.get(`/api/apps/${app.id}`).expect(200);
    await v.get(`/api/apps/${app.id}/deployments`).expect(200);
    await v.get(`/api/deployments/${deploymentId}/logs`).expect(200);
    await v.get(`/api/apps/${app.id}/env`).expect(200);
    await v.get(`/api/apps/${app.id}/domains`).expect(200);
    for (const res of await Promise.all([
      v.post(`/api/apps/${app.id}/deployments`),
      v.post(`/api/apps/${app.id}/env`, { key: 'NEW_VAR', value: 'x' }),
      v.put(`/api/apps/${app.id}/env/SECRET_TOKEN`, { value: 'x' }),
      v.patch(`/api/apps/${app.id}`, { port: 9000 }),
      v.post(`/api/apps/${app.id}/restart`),
      v.post(`/api/deployments/${deploymentId}/cancel`),
      v.post(`/api/deployments/${deploymentId}/rollback`, { confirm: true }),
      v.post(`/api/apps/${app.id}/domains`, { hostname: 'v.example.com' }),
      v.get(`/api/workspaces/${owner.workspaceId}/audit`),
      v.post(`/api/workspaces/${owner.workspaceId}/invites`, { email: 'y@example.com', role: 'viewer' }),
      v.del(`/api/apps/${app.id}`, { confirmSlug: 'alpha-web' }),
    ])) {
      expect(res.status, `${res.req.method} ${res.req.path}`).toBe(403);
    }
  });

  it('developers manage apps and deployments but not members or destructive settings', async () => {
    const d = as(dev);
    await d.patch(`/api/apps/${app.id}`, { port: 3001 }).expect(200);
    await d.post(`/api/apps/${app.id}/env`, { key: 'DEV_VAR', value: 'x', secret: false }).expect(201);
    await d.get(`/api/workspaces/${owner.workspaceId}/audit`).expect(200);
    await d.del(`/api/apps/${app.id}`, { confirmSlug: 'alpha-web' }).expect(403);
    await d.post(`/api/workspaces/${owner.workspaceId}/invites`, { email: 'z@example.com', role: 'owner' }).expect(403);
    await d.patch(`/api/workspaces/${owner.workspaceId}/members/${viewer.userId}`, { role: 'owner' }).expect(403);
    await d.post(`/api/workspaces/${owner.workspaceId}/github/connect`).expect(403);
  });

  it('owners cannot remove or demote the last owner', async () => {
    await as(owner).patch(`/api/workspaces/${owner.workspaceId}/members/${owner.userId}`, { role: 'viewer' }).expect(409);
    await as(owner).del(`/api/workspaces/${owner.workspaceId}/members/${owner.userId}`).expect(409);
  });

  it('removing a member revokes their access immediately', async () => {
    const temp = await addMember(h, owner, 'temp@example.com', 'developer');
    await as(temp).get(`/api/apps/${app.id}`).expect(200);
    await as(owner).del(`/api/workspaces/${owner.workspaceId}/members/${temp.userId}`).expect(204);
    await as(temp).get(`/api/apps/${app.id}`).expect(404);
  });

  it('keeps role changes effective for bearer-token clients too', async () => {
    const tok = await h.http.post('/api/auth/token').send({ email: 'viewer@example.com', password: PASSWORD, deviceName: 'phone' }).expect(200);
    await request(h.app.getHttpServer()).post(`/api/apps/${app.id}/deployments`).set('authorization', `Bearer ${tok.body.accessToken}`).send({}).expect(403);
    await request(h.app.getHttpServer()).get(`/api/apps/${app.id}`).set('authorization', `Bearer ${tok.body.accessToken}`).expect(200);
  });

  it('restricts platform diagnostics to owners/admins', async () => {
    await as(viewer).get('/api/diagnostics').expect(403);
    await as(dev).get('/api/diagnostics').expect(403);
  });
});
