import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { GithubInstallationView, GithubRepoView, Paginated } from '@deployforge/contracts';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { conflict, forbidden, notFound } from '../common/errors';
import { randomToken, sha256Hex } from '../crypto/tokens';
import { Auth, Meta, Public, type AuthContext, type RequestMeta, type RequestWithAuth } from '../auth/auth.types';
import { GITHUB_CLIENT } from './github.module';
import type { GithubClient } from './github.client';
import { verifyGithubSignature } from './webhook-signature';
import { OutboxService } from '../engine/outbox.service';
import type { Prisma } from '../generated/prisma/client';

const connectSchema = z.object({ returnTo: z.enum(['web', 'mobile']).default('web') });
const DELIVERY_RE = /^[A-Za-z0-9-]{8,64}$/;
const HANDLED_EVENTS = new Set(['push', 'installation', 'installation_repositories']);

@ApiTags('github')
@Controller('api')
export class GithubController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(GITHUB_CLIENT) private readonly github: GithubClient | null,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private client(): GithubClient {
    if (!this.github) throw notFound('GitHub integration');
    return this.github;
  }

  // ---- webhooks ----

  @Public()
  @Post('github/webhooks')
  @HttpCode(202)
  @ApiOperation({ summary: 'GitHub App webhook receiver (HMAC-SHA256 verified over the raw body; deliveries deduplicated)' })
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
    @Headers('x-github-event') event: string | undefined,
  ) {
    if (!this.github || !this.config.GITHUB_WEBHOOK_SECRET) throw notFound('GitHub integration');
    const raw = req.rawBody;
    if (!raw || !verifyGithubSignature(this.config.GITHUB_WEBHOOK_SECRET, raw, signature)) {
      throw forbidden('Invalid webhook signature');
    }
    if (!deliveryId || !DELIVERY_RE.test(deliveryId) || !event) throw forbidden('Missing delivery headers');
    if (event === 'ping') return { ok: true };
    const payload = req.body as Record<string, unknown>;
    const installationId = (payload.installation as { id?: number } | undefined)?.id ?? null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.webhookDelivery.create({
          data: {
            id: deliveryId,
            event,
            action: typeof payload.action === 'string' ? payload.action : null,
            installationId,
            status: HANDLED_EVENTS.has(event) ? 'queued' : 'ignored',
            payload: (HANDLED_EVENTS.has(event) ? payload : {}) as Prisma.InputJsonValue,
            ...(HANDLED_EVENTS.has(event) ? {} : { processedAt: new Date() }),
          },
        });
        if (HANDLED_EVENTS.has(event)) await this.outbox.add(tx, 'webhook.process', { deliveryId }, { dedupeKey: `webhook:${deliveryId}` });
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return { ok: true, duplicate: true };
      throw e;
    }
    await this.outbox.notify();
    return { ok: true };
  }

  // ---- installation flow ----

  @Post('workspaces/:id/github/connect')
  @ApiOperation({ summary: 'Start connecting a GitHub App installation (owner). Returns the GitHub URL to open in a browser.' })
  async connect(@Auth() auth: AuthContext, @Param('id') workspaceId: string, @Body(new ZodPipe(connectSchema)) body: z.infer<typeof connectSchema>): Promise<{ url: string }> {
    await this.access.workspace(auth, workspaceId, 'github.connect');
    const gh = this.client();
    const state = randomToken('', 24);
    await this.prisma.githubConnectState.create({
      data: { stateHash: sha256Hex(state), workspaceId, userId: auth.userId, returnTo: body.returnTo, expiresAt: new Date(Date.now() + 15 * 60_000) },
    });
    return { url: gh.installUrl(state) };
  }

  /**
   * GitHub "Setup URL" callback. The one-time state binds the request to the
   * user and workspace that started it; the OAuth code proves the GitHub user
   * can access the installation (so a guessed installation_id cannot be
   * bound). Redirects only to fixed dashboard/app locations.
   */
  @Public()
  @Get('github/setup')
  @ApiOperation({ summary: 'GitHub App installation callback (browser redirect target)' })
  async setup(
    @Req() req: RequestWithAuth,
    @Res() res: Response,
    @Meta() meta: RequestMeta,
    @Query('installation_id') installationIdQ?: string,
    @Query('state') state?: string,
    @Query('code') code?: string,
  ): Promise<void> {
    const gh = this.client();
    const base = this.config.PUBLIC_URL.replace(/\/$/, '');
    const fail = (reason: string) => res.redirect(302, `${base}/github/result?status=error&reason=${encodeURIComponent(reason)}`);
    if (!state || !code || !installationIdQ || !/^\d{1,12}$/.test(installationIdQ)) return fail('missing_parameters');
    const row = await this.prisma.githubConnectState.findUnique({ where: { stateHash: sha256Hex(state) } });
    if (!row || row.usedAt || row.expiresAt <= new Date()) return fail('invalid_state');
    if (req.auth && req.auth.userId !== row.userId) return fail('user_mismatch');
    await this.prisma.githubConnectState.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    const role = await this.access.role(row.userId, row.workspaceId);
    if (role !== 'owner') return fail('not_authorized');
    const installationId = Number(installationIdQ);
    let ids: number[];
    try {
      ids = await gh.userInstallationIds(code);
    } catch {
      return fail('oauth_failed');
    }
    if (!ids.includes(installationId)) return fail('installation_not_accessible');
    const info = await gh.getInstallation(installationId);
    if (!info) return fail('installation_not_found');
    const existing = await this.prisma.githubInstallation.findUnique({ where: { githubInstallationId: installationId } });
    if (existing && existing.workspaceId !== row.workspaceId && existing.status !== 'deleted') return fail('bound_to_another_workspace');
    const inst = await this.prisma.githubInstallation.upsert({
      where: { githubInstallationId: installationId },
      create: { workspaceId: row.workspaceId, githubInstallationId: installationId, accountLogin: info.accountLogin, accountType: info.accountType, status: info.suspended ? 'suspended' : 'active', createdById: row.userId },
      update: { workspaceId: row.workspaceId, accountLogin: info.accountLogin, accountType: info.accountType, status: info.suspended ? 'suspended' : 'active' },
    });
    await this.prisma.application.updateMany({ where: { githubInstallationId: inst.id, sourceStatus: 'installation_disconnected' }, data: { sourceStatus: 'ok' } });
    await this.audit.record({ workspaceId: row.workspaceId, actorId: row.userId, action: 'github.installation_connected', targetType: 'github_installation', targetId: inst.id, metadata: { account: info.accountLogin }, meta });
    if (row.returnTo === 'mobile') {
      res.redirect(302, `${base}/github/result?status=connected&workspace=${encodeURIComponent(row.workspaceId)}&return=mobile`);
      return;
    }
    res.redirect(302, `${base}/w/${encodeURIComponent(row.workspaceId)}/settings?github=connected`);
  }

  /** TEST FIXTURE ONLY: simulates GitHub's install page redirect. */
  @Public()
  @Get('__fixture/github/install')
  @ApiExcludeEndpoint()
  fixtureInstall(@Query('state') state: string, @Query('installation_id') inst: string | undefined, @Query('code') code: string | undefined, @Res() res: Response): void {
    if (this.github?.mode !== 'fixture') throw notFound('Route');
    res.redirect(302, `/api/github/setup?installation_id=${encodeURIComponent(inst ?? '1001')}&setup_action=install&state=${encodeURIComponent(state)}&code=${encodeURIComponent(code ?? 'fixture-code')}`);
  }

  @Get('workspaces/:id/github/installations')
  @ApiOperation({ summary: 'GitHub installations bound to this workspace' })
  async installations(@Auth() auth: AuthContext, @Param('id') workspaceId: string): Promise<GithubInstallationView[]> {
    await this.access.workspace(auth, workspaceId, 'github.read');
    const rows = await this.prisma.githubInstallation.findMany({ where: { workspaceId, status: { not: 'deleted' } }, orderBy: { createdAt: 'asc' } });
    return rows.map((i) => ({ id: i.id, githubInstallationId: i.githubInstallationId, accountLogin: i.accountLogin, accountType: i.accountType, status: i.status as GithubInstallationView['status'], createdAt: i.createdAt.toISOString() }));
  }

  @Delete('github/installations/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Disconnect an installation from the workspace (owner). Uninstall on GitHub separately.' })
  async disconnect(@Auth() auth: AuthContext, @Param('id') id: string, @Meta() meta: RequestMeta): Promise<void> {
    const inst = await this.prisma.githubInstallation.findUnique({ where: { id } });
    if (!inst) throw notFound('Installation');
    await this.access.check(auth, inst.workspaceId, 'github.connect', 'Installation');
    await this.prisma.githubInstallation.update({ where: { id }, data: { status: 'deleted' } });
    await this.prisma.application.updateMany({ where: { githubInstallationId: id }, data: { sourceStatus: 'installation_disconnected', autoDeploy: false } });
    await this.audit.record({ workspaceId: inst.workspaceId, actorId: auth.userId, action: 'github.installation_disconnected', targetType: 'github_installation', targetId: id, meta });
  }

  private async installationFor(auth: AuthContext, id: string) {
    const inst = await this.prisma.githubInstallation.findUnique({ where: { id } });
    if (!inst) throw notFound('Installation');
    await this.access.check(auth, inst.workspaceId, 'github.read', 'Installation');
    if (inst.status !== 'active') throw conflict('This installation is not active', 'installation_inactive');
    return inst;
  }

  @Get('github/installations/:id/repos')
  @ApiOperation({ summary: 'Repositories the installation can access (paginated)' })
  async repos(@Auth() auth: AuthContext, @Param('id') id: string, @Query('page') pageQ?: string): Promise<Paginated<GithubRepoView> & { total: number }> {
    const inst = await this.installationFor(auth, id);
    const page = Math.max(1, Number.parseInt(pageQ ?? '1', 10) || 1);
    const r = await this.client().listRepos(inst.githubInstallationId, page, 50);
    return { items: r.repos, total: r.total, nextCursor: page * 50 < r.total ? String(page + 1) : null };
  }

  @Get('github/installations/:id/branches')
  @ApiOperation({ summary: 'Branches of a repository accessible to the installation' })
  async branches(@Auth() auth: AuthContext, @Param('id') id: string, @Query('repositoryId') repoIdQ: string, @Query('page') pageQ?: string): Promise<Paginated<string>> {
    const inst = await this.installationFor(auth, id);
    const repo = await this.client().getRepo(inst.githubInstallationId, Number(repoIdQ));
    if (!repo) throw notFound('Repository');
    const page = Math.max(1, Number.parseInt(pageQ ?? '1', 10) || 1);
    const r = await this.client().listBranches(inst.githubInstallationId, repo.fullName, page);
    return { items: r.names, nextCursor: r.hasMore ? String(page + 1) : null };
  }
}
