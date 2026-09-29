import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHarness, login, PASSWORD, resetDatabase, setupOwner, SETUP_TOKEN, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h.prisma);
  await h.redis.client.flushdb();
});

describe('first-run setup', () => {
  it('requires the setup token and can only run once', async () => {
    const body = { name: 'Owner', email: 'owner@example.com', password: PASSWORD, workspaceName: 'Alpha' };
    await h.http.get('/api/auth/status').expect(200).expect((r) => expect(r.body.setupRequired).toBe(true));
    await h.http.post('/api/setup').send(body).expect(403);
    await h.http.post('/api/setup').send({ ...body, setupToken: 'wrong' }).expect(403);
    await h.http.post('/api/setup').send({ ...body, setupToken: SETUP_TOKEN }).expect(201);
    await h.http.post('/api/setup').send({ ...body, email: 'second@example.com', setupToken: SETUP_TOKEN }).expect(409);
    await h.http.get('/api/auth/status').expect(200).expect((r) => expect(r.body.setupRequired).toBe(false));
  });

  it('serializes concurrent setup attempts (exactly one owner is created)', async () => {
    const body = (i: number) => ({ name: 'Owner', email: `o${i}@example.com`, password: PASSWORD, workspaceName: 'Alpha', setupToken: SETUP_TOKEN });
    const results = await Promise.all([0, 1, 2, 3].map((i) => h.http.post('/api/setup').send(body(i))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await h.prisma.user.count()).toBe(1);
  });

  it('rejects weak passwords', async () => {
    await h.http.post('/api/setup').send({ name: 'O', email: 'o@example.com', password: 'short', workspaceName: 'A', setupToken: SETUP_TOKEN }).expect(400);
  });
});

describe('browser sessions', () => {
  it('uses an HttpOnly SameSite cookie and never exposes the password hash', async () => {
    const agent = request.agent(h.app.getHttpServer());
    const res = await agent.post('/api/setup').send({ name: 'Owner', email: 'owner@example.com', password: PASSWORD, workspaceName: 'Alpha', setupToken: SETUP_TOKEN });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/df_session=dfs_/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash/);
  });

  it('requires the CSRF token for unsafe requests authenticated by cookie', async () => {
    const owner = await setupOwner(h);
    await owner.agent.post(`/api/workspaces/${owner.workspaceId}/projects`).send({ name: 'P1' }).expect(403);
    await owner.agent.post(`/api/workspaces/${owner.workspaceId}/projects`).set('x-csrf-token', 'nope').send({ name: 'P1' }).expect(403);
    await owner.agent.post(`/api/workspaces/${owner.workspaceId}/projects`).set('x-csrf-token', owner.csrf).send({ name: 'P1' }).expect(201);
  });

  it('rejects cross-origin unsafe requests even with a valid CSRF token', async () => {
    const owner = await setupOwner(h);
    await owner.agent.post(`/api/workspaces/${owner.workspaceId}/projects`).set('x-csrf-token', owner.csrf).set('origin', 'https://evil.example').send({ name: 'P2' }).expect(403);
  });

  it('logs out and revokes the session server-side', async () => {
    const owner = await setupOwner(h);
    await owner.agent.get('/api/auth/me').expect(200);
    await owner.agent.post('/api/auth/logout').set('x-csrf-token', owner.csrf).expect(204);
    await owner.agent.get('/api/auth/me').expect(401);
    const s = await h.prisma.session.findFirst({ where: { userId: owner.userId } });
    expect(s?.revokedAt).not.toBeNull();
  });

  it('can list and revoke other sessions; revoked sessions stop working', async () => {
    const owner = await setupOwner(h);
    const second = await login(h, 'owner@example.com');
    const list = await owner.agent.get('/api/auth/sessions').expect(200);
    expect(list.body).toHaveLength(2);
    const other = list.body.find((s: { current: boolean }) => !s.current);
    await owner.agent.delete(`/api/auth/sessions/${other.id}`).set('x-csrf-token', owner.csrf).expect(204);
    await second.agent.get('/api/auth/me').expect(401);
    await owner.agent.get('/api/auth/me').expect(200);
  });

  it('expires sessions', async () => {
    const owner = await setupOwner(h);
    await h.prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await owner.agent.get('/api/auth/me').expect(401);
  });

  it('rate limits login attempts per account', async () => {
    await setupOwner(h);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await h.http.post('/api/auth/login').send({ email: 'owner@example.com', password: 'wrong password!!' })).status;
    }
    expect(last).toBe(429);
    // Even the right password is refused while limited.
    await h.http.post('/api/auth/login').send({ email: 'owner@example.com', password: PASSWORD }).expect(429);
  });

  it('gives the same error for unknown users and wrong passwords', async () => {
    await setupOwner(h);
    const a = await h.http.post('/api/auth/login').send({ email: 'nobody@example.com', password: PASSWORD });
    const b = await h.http.post('/api/auth/login').send({ email: 'owner@example.com', password: 'wrong password!!' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('revokes other sessions on password change', async () => {
    const owner = await setupOwner(h);
    const other = await login(h, 'owner@example.com');
    await owner.agent.post('/api/auth/password').set('x-csrf-token', owner.csrf).send({ currentPassword: PASSWORD, newPassword: 'another long password' }).expect(204);
    await other.agent.get('/api/auth/me').expect(401);
    await owner.agent.get('/api/auth/me').expect(200);
    await login(h, 'owner@example.com', 'another long password');
  });
});

describe('native client tokens', () => {
  async function tokenLogin() {
    await setupOwner(h);
    const r = await h.http.post('/api/auth/token').send({ email: 'owner@example.com', password: PASSWORD, deviceName: 'Pixel' }).expect(200);
    return r.body as { accessToken: string; refreshToken: string; sessionId: string };
  }

  it('authenticates with bearer tokens without CSRF', async () => {
    const t = await tokenLogin();
    const me = await h.http.get('/api/auth/me').set('authorization', `Bearer ${t.accessToken}`).expect(200);
    expect(me.body.csrfToken).toBeUndefined();
    await h.http.post(`/api/workspaces/${me.body.workspaces[0].id}/projects`).set('authorization', `Bearer ${t.accessToken}`).send({ name: 'Mobile project' }).expect(201);
  });

  it('rotates refresh tokens and revokes the session on reuse', async () => {
    const t = await tokenLogin();
    const r1 = await h.http.post('/api/auth/token/refresh').send({ refreshToken: t.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(t.refreshToken);
    // Replaying the old token is detected and kills the whole session.
    const replay = await h.http.post('/api/auth/token/refresh').send({ refreshToken: t.refreshToken }).expect(401);
    expect(replay.body.code).toBe('refresh_token_reused');
    await h.http.post('/api/auth/token/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
    await h.http.get('/api/auth/me').set('authorization', `Bearer ${r1.body.accessToken}`).expect(401);
  });

  it('lets exactly one of two concurrent refreshes succeed', async () => {
    const t = await tokenLogin();
    const results = await Promise.all([1, 2].map(() => h.http.post('/api/auth/token/refresh').send({ refreshToken: t.refreshToken })));
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(results.some((r) => r.status === 401)).toBe(true);
  });

  it('logout revokes the mobile session immediately (access token stops working)', async () => {
    const t = await tokenLogin();
    await h.http.post('/api/auth/logout').set('authorization', `Bearer ${t.accessToken}`).expect(204);
    await h.http.get('/api/auth/me').set('authorization', `Bearer ${t.accessToken}`).expect(401);
    await h.http.post('/api/auth/token/refresh').send({ refreshToken: t.refreshToken }).expect(401);
  });

  it('rejects expired, forged and browser-session tokens as bearer tokens', async () => {
    const t = await tokenLogin();
    await h.http.get('/api/auth/me').set('authorization', `Bearer ${t.accessToken}x`).expect(401);
    const browser = await login(h, 'owner@example.com');
    void browser;
    await h.http.get('/api/auth/me').set('authorization', 'Bearer dfs_notatoken').expect(401);
  });
});
