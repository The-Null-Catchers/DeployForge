import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { CONFIG, loadConfig, type AppConfig } from '../src/config/config';
import { PrismaService } from '../src/common/prisma.service';
import { RedisService } from '../src/common/redis.service';
import { GITHUB_CLIENT } from '../src/github/github.module';
import { FixtureGithubClient, type FixtureData } from '../src/github/github.client';
import { FakeRunner } from './fake-runner';
import { testEnv } from './env';

export const SETUP_TOKEN = 'test-setup-token-0123456789';
export const WEBHOOK_SECRET = 'test-webhook-secret';
export const PASSWORD = 'correct horse battery staple';

export interface Harness {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  prisma: PrismaService;
  redis: RedisService;
  config: AppConfig;
  runner: FakeRunner;
  github: FixtureGithubClient;
  close(): Promise<void>;
}

export async function createHarness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const env = testEnv();
  const runnerSecret = randomBytes(24).toString('hex');
  const runner = new FakeRunner(runnerSecret);
  await runner.start();
  const vars: Record<string, string> = {
    NODE_ENV: 'test',
    DEPLOYFORGE_PROCESS: 'api',
    DATABASE_URL: env.databaseUrl,
    REDIS_URL: env.redisUrl,
    PUBLIC_URL: 'http://localhost:5173',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    DEPLOYFORGE_MASTER_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    DEPLOYFORGE_ACTIVE_KEY_ID: 'k1',
    SETUP_TOKEN,
    RUNNER_URL: runner.url,
    RUNNER_SHARED_SECRET: runnerSecret,
    PROXY_PROBE_TOKEN: 'probe-token-for-tests',
    CADDY_ADMIN_URL: 'http://127.0.0.1:1',
    APPS_DOMAIN: 'apps.test',
    GITHUB_MODE: 'fixture',
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GIT_EXTRA_ALLOWED_HOSTS: 'git-fixture:8080',
    API_DOCS_ENABLED: 'false',
    ...extraEnv,
  };
  const config = loadConfig({ ...process.env, ...vars });
  const github = new FixtureGithubClient({ installations: [] });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONFIG)
    .useValue(config)
    .overrideProvider(GITHUB_CLIENT)
    .useValue(github)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: ['error'] });
  configureApp(app, config);
  await app.init();
  app.getHttpServer().setMaxListeners(100);
  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);
  await resetDatabase(prisma);
  await redis.client.flushdb();
  return {
    app,
    http: request(app.getHttpServer()),
    prisma,
    redis,
    config,
    runner,
    github,
    async close() {
      await app.close();
      await runner.stop();
    },
  };
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

/** A logged-in browser client: cookie jar + CSRF token. */
export interface BrowserClient {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  userId: string;
  workspaceId: string;
}

export async function setupOwner(h: Harness): Promise<BrowserClient> {
  const agent = request.agent(h.app.getHttpServer());
  const res = await agent.post('/api/setup').send({ name: 'Owner', email: 'owner@example.com', password: PASSWORD, workspaceName: 'Alpha', setupToken: SETUP_TOKEN }).expect(201);
  return { agent, csrf: res.body.csrfToken, userId: res.body.user.id, workspaceId: res.body.workspaces[0].id };
}

export async function login(h: Harness, email: string, password = PASSWORD): Promise<BrowserClient> {
  const agent = request.agent(h.app.getHttpServer());
  const res = await agent.post('/api/auth/login').send({ email, password }).expect(200);
  return { agent, csrf: res.body.csrfToken, userId: res.body.user.id, workspaceId: res.body.workspaces[0]?.id };
}

/** Invite + accept, returning a logged-in client for the new member. */
export async function addMember(h: Harness, owner: BrowserClient, email: string, role: 'owner' | 'developer' | 'viewer', workspaceId = owner.workspaceId): Promise<BrowserClient> {
  const inv = await owner.agent.post(`/api/workspaces/${workspaceId}/invites`).set('x-csrf-token', owner.csrf).send({ email, role }).expect(201);
  const token = String(inv.body.inviteUrl).split('/invite/')[1];
  const agent = request.agent(h.app.getHttpServer());
  const res = await agent.post('/api/invites/accept').send({ token, name: email.split('@')[0], password: PASSWORD }).expect(201);
  return { agent, csrf: res.body.csrfToken, userId: res.body.user.id, workspaceId };
}

export async function createApp(h: Harness, client: BrowserClient, slug = 'web', extra: Record<string, unknown> = {}) {
  const projects = await client.agent.get(`/api/workspaces/${client.workspaceId}/projects`).expect(200);
  const res = await client.agent
    .post(`/api/workspaces/${client.workspaceId}/apps`)
    .set('x-csrf-token', client.csrf)
    .send({ projectId: projects.body[0].id, name: slug, slug, source: { type: 'public', repoUrl: 'https://github.com/acme/web' }, branch: 'main', ...extra });
  if (res.status !== 201) throw new Error(`create app failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; slug: string; workspaceId: string };
}

export function fixtureData(cloneUrl = 'https://github.com/acme/private-app.git'): FixtureData {
  return {
    installations: [
      {
        id: 1001,
        accountLogin: 'acme',
        oauthCode: 'fixture-code',
        token: 'ghs_fixture_installation_token_value',
        repos: [
          { id: 555, fullName: 'acme/private-app', private: true, defaultBranch: 'main', htmlUrl: 'https://github.com/acme/private-app', cloneUrl, branches: ['main', 'develop'] },
          { id: 556, fullName: 'acme/other', private: false, defaultBranch: 'main', htmlUrl: 'https://github.com/acme/other', cloneUrl: 'https://github.com/acme/other.git', branches: ['main'] },
        ],
      },
      { id: 2002, accountLogin: 'mallory', oauthCode: 'mallory-code', token: 'ghs_mallory', repos: [] },
    ],
  };
}
