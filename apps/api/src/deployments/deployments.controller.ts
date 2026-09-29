import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createDeploymentRequestSchema,
  isTerminal,
  redactAll,
  redactionNeedles,
  retainReleaseRequestSchema,
  rollbackRequestSchema,
  type DeploymentEventView,
  type DeploymentStatus,
  type DeploymentSummary,
  type DeploymentView,
  type LogEvent,
  type Paginated,
} from '@deployforge/contracts';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { notFound } from '../common/errors';
import { jsonSchema } from '../common/openapi';
import { Auth, Meta, type AuthContext, type RequestMeta } from '../auth/auth.types';
import { SessionService } from '../auth/session.service';
import { DeploymentsService } from './deployments.service';
import { LiveService } from './live.service';
import { deploymentSummary, deploymentView } from './views';
import { SseStream, waitFor } from './sse';
import { RunnerClient, RunnerError } from '../runner/runner.client';
import { EnvService } from '../applications/env.service';

const cursorSchema = z.string().regex(/^\d{1,19}\.\d{1,19}$/);

@ApiTags('deployments')
@Controller('api')
export class DeploymentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly deployments: DeploymentsService,
    private readonly audit: AuditService,
    private readonly live: LiveService,
    private readonly sessions: SessionService,
    private readonly runner: RunnerClient,
    private readonly env: EnvService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('apps/:id/deployments')
  @ApiOperation({ summary: 'Deployment history, newest first' })
  async list(@Auth() auth: AuthContext, @Param('id') id: string, @Query('cursor') cursor?: string): Promise<Paginated<DeploymentSummary & { canRollback: boolean; imageAvailable: boolean; pinned: boolean }>> {
    const { app } = await this.access.app(auth, id, 'deployment.read');
    const before = cursor ? Number.parseInt(cursor, 10) : undefined;
    const rows = await this.prisma.deployment.findMany({
      where: { applicationId: app.id, ...(before ? { number: { lt: before } } : {}) },
      orderBy: { number: 'desc' },
      take: 26,
    });
    const page = rows.slice(0, 25);
    return {
      items: page.map((d) => ({
        ...deploymentSummary(d),
        imageAvailable: !!d.imageId && !d.imagePrunedAt,
        pinned: d.pinned,
        canRollback: d.status === 'succeeded' && !!d.imageId && !d.imagePrunedAt && d.id !== app.activeDeploymentId,
      })),
      nextCursor: rows.length > 25 ? String(page[page.length - 1]!.number) : null,
    };
  }

  @Post('apps/:id/deployments')
  @ApiOperation({ summary: 'Deploy the branch head (resolved to an exact SHA now) or a specific commit' })
  @ApiBody({ schema: jsonSchema(createDeploymentRequestSchema) })
  async create(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodPipe(createDeploymentRequestSchema)) body: z.infer<typeof createDeploymentRequestSchema>, @Meta() meta: RequestMeta, @Headers('idempotency-key') idem?: string): Promise<DeploymentView> {
    const { app } = await this.access.app(auth, id, 'deployment.create');
    const idempotencyKey = idem && /^[A-Za-z0-9_-]{8,100}$/.test(idem) ? `manual:${app.id}:${idem}` : undefined;
    const d = await this.deployments.create(app, { trigger: 'manual', actorId: auth.userId, commitSha: body.commitSha, idempotencyKey, meta });
    return this.view(d.id);
  }

  @Post('apps/:id/redeploy')
  @ApiOperation({ summary: 'Rebuild the active commit with the current configuration and variables' })
  async redeploy(@Auth() auth: AuthContext, @Param('id') id: string, @Meta() meta: RequestMeta): Promise<DeploymentView> {
    const { app } = await this.access.app(auth, id, 'deployment.create');
    const active = app.activeDeploymentId ? await this.prisma.deployment.findUnique({ where: { id: app.activeDeploymentId } }) : null;
    if (!active?.commitSha) throw notFound('Active release');
    const d = await this.deployments.create(app, { trigger: 'redeploy', actorId: auth.userId, commitSha: active.commitSha, commitMessage: active.commitMessage ?? undefined, meta });
    return this.view(d.id);
  }

  @Get('deployments/:id')
  @ApiOperation({ summary: 'Deployment details with stage timeline' })
  async get(@Auth() auth: AuthContext, @Param('id') id: string): Promise<DeploymentView> {
    await this.access.deployment(auth, id, 'deployment.read');
    return this.view(id);
  }

  async view(id: string): Promise<DeploymentView> {
    const d = await this.prisma.deployment.findUniqueOrThrow({
      where: { id },
      include: { stages: true, configRevision: true, envRevision: true, rollbackOf: true, application: { select: { activeDeploymentId: true } } },
    });
    const actor = d.actorId ? await this.prisma.user.findUnique({ where: { id: d.actorId }, select: { id: true, name: true } }) : null;
    const previousActive = d.previousActiveId ? await this.prisma.deployment.findUnique({ where: { id: d.previousActiveId } }) : null;
    return deploymentView(d, { actor, previousActive, activeDeploymentId: d.application.activeDeploymentId });
  }

  @Post('deployments/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a deployment before its promotion step' })
  async cancel(@Auth() auth: AuthContext, @Param('id') id: string, @Meta() meta: RequestMeta): Promise<DeploymentView> {
    const { deployment } = await this.access.deployment(auth, id, 'deployment.cancel');
    await this.deployments.cancel(deployment, auth.userId, meta);
    return this.view(id);
  }

  @Post('deployments/:id/rollback')
  @ApiOperation({
    summary: 'Roll back to this retained release without rebuilding',
    description:
      'Creates a new deployment that reuses this release image, configuration revision and environment revision. ' +
      'Old environment revisions may contain expired or revoked credentials. Rollback does not reverse database migrations or external side effects.',
  })
  @ApiBody({ schema: jsonSchema(rollbackRequestSchema) })
  async rollback(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodPipe(rollbackRequestSchema)) _body: z.infer<typeof rollbackRequestSchema>, @Meta() meta: RequestMeta): Promise<DeploymentView> {
    const { deployment, app } = await this.access.deployment(auth, id, 'deployment.rollback');
    const d = await this.deployments.rollback(app, deployment, auth.userId, meta);
    return this.view(d.id);
  }

  @Post('deployments/:id/pin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pin/unpin a release so image retention keeps it as a rollback target' })
  @ApiBody({ schema: jsonSchema(retainReleaseRequestSchema) })
  async pin(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodPipe(retainReleaseRequestSchema)) body: z.infer<typeof retainReleaseRequestSchema>, @Meta() meta: RequestMeta): Promise<DeploymentView> {
    const { deployment } = await this.access.deployment(auth, id, 'deployment.rollback');
    await this.prisma.deployment.update({ where: { id }, data: { pinned: body.pinned } });
    await this.audit.record({ workspaceId: deployment.workspaceId, actorId: auth.userId, action: body.pinned ? 'deployment.pinned' : 'deployment.unpinned', targetType: 'deployment', targetId: id, meta });
    return this.view(id);
  }

  @Get('deployments/:id/events')
  @ApiOperation({ summary: 'Deployment event timeline' })
  async events(@Auth() auth: AuthContext, @Param('id') id: string): Promise<DeploymentEventView[]> {
    await this.access.deployment(auth, id, 'deployment.read');
    const rows = await this.prisma.deploymentEvent.findMany({ where: { deploymentId: id }, orderBy: { id: 'asc' }, take: 1000 });
    return rows.map((e) => ({ id: e.id.toString(), ts: e.ts.toISOString(), type: e.type, message: e.message, level: e.level as DeploymentEventView['level'] }));
  }

  @Get('deployments/:id/logs')
  @ApiOperation({ summary: 'Build log page. Filter with q (substring) and stream.' })
  async logs(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
    @Query('stream') stream?: string,
  ): Promise<{ items: LogEvent[]; nextCursor: string | null; truncated: boolean; expired: boolean }> {
    const { deployment } = await this.access.deployment(auth, id, 'logs.read');
    const take = Math.min(Math.max(Number.parseInt(limit ?? '1000', 10) || 1000, 1), 5000);
    const afterId = after && /^\d+$/.test(after) ? BigInt(after) : 0n;
    const rows = await this.prisma.deploymentLog.findMany({
      where: {
        deploymentId: id,
        id: { gt: afterId },
        ...(q ? { text: { contains: q.slice(0, 200), mode: 'insensitive' as const } } : {}),
        ...(stream && ['stdout', 'stderr', 'system'].includes(stream) ? { stream } : {}),
      },
      orderBy: { id: 'asc' },
      take,
    });
    return {
      items: rows.map((r) => ({ id: r.id.toString(), ts: r.ts.toISOString(), stream: r.stream as LogEvent['stream'], text: r.text })),
      nextCursor: rows.length === take ? rows[rows.length - 1]!.id.toString() : null,
      truncated: deployment.logsTruncated,
      expired: !!deployment.logsExpiredAt,
    };
  }

  @Get('deployments/:id/logs/download')
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'Download the full build log as text' })
  async download(@Auth() auth: AuthContext, @Param('id') id: string, @Res() res: Response): Promise<void> {
    const { deployment, app } = await this.access.deployment(auth, id, 'logs.read');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${app.slug}-deployment-${deployment.number}.log"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let after = 0n;
    for (;;) {
      const rows = await this.prisma.deploymentLog.findMany({ where: { deploymentId: id, id: { gt: after } }, orderBy: { id: 'asc' }, take: 2000 });
      if (rows.length === 0) break;
      const chunk = rows.map((r) => `${r.ts.toISOString()} [${r.stream}] ${r.text}\n`).join('');
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      after = rows[rows.length - 1]!.id;
    }
    if (deployment.logsExpiredAt) res.write(`# Build logs expired under the retention policy on ${deployment.logsExpiredAt.toISOString()}\n`);
    res.end();
  }

  /**
   * Live deployment stream: build log lines, timeline events and status.
   * Event IDs are "<lastLogId>.<lastEventId>", so a reconnect with
   * Last-Event-ID resumes exactly where the client left off.
   */
  @Get('deployments/:id/stream')
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: 'SSE: live build logs, events and status (resumable via Last-Event-ID)' })
  async stream(@Auth() auth: AuthContext, @Param('id') id: string, @Req() req: Request, @Res() res: Response, @Query('cursor') cursorQ?: string): Promise<void> {
    await this.access.deployment(auth, id, 'logs.read');
    const raw = (req.headers['last-event-id'] as string | undefined) ?? cursorQ ?? '0.0';
    const cursor = cursorSchema.safeParse(raw).success ? raw : '0.0';
    let [logId, eventId] = cursor.split('.').map((x) => BigInt(x)) as [bigint, bigint];
    const sse = SseStream.open(req, res, auth.userId);
    if (!sse) return;
    let lastStatus = '';
    let lastSessionCheck = Date.now();
    const id2 = () => `${logId}.${eventId}`;
    try {
      while (!sse.closed) {
        let progressed = false;
        const logs = await this.prisma.deploymentLog.findMany({ where: { deploymentId: id, id: { gt: logId } }, orderBy: { id: 'asc' }, take: 500 });
        for (const l of logs) {
          logId = l.id;
          await sse.send('log', { id: l.id.toString(), ts: l.ts.toISOString(), stream: l.stream, text: l.text }, id2());
        }
        progressed ||= logs.length > 0;
        const events = await this.prisma.deploymentEvent.findMany({ where: { deploymentId: id, id: { gt: eventId } }, orderBy: { id: 'asc' }, take: 200 });
        for (const e of events) {
          eventId = e.id;
          await sse.send('event', { id: e.id.toString(), ts: e.ts.toISOString(), type: e.type, level: e.level, message: e.message }, id2());
        }
        progressed ||= events.length > 0;
        const d = await this.prisma.deployment.findUnique({ where: { id }, select: { status: true, releaseState: true, updatedAt: true } });
        if (!d) break;
        const sig = `${d.status}:${d.releaseState}:${d.updatedAt.getTime()}`;
        if (sig !== lastStatus) {
          lastStatus = sig;
          await sse.send('status', await this.view(id), id2());
        }
        if (isTerminal(d.status as DeploymentStatus) && !progressed) {
          await sse.send('end', { status: d.status }, id2());
          break;
        }
        if (Date.now() - lastSessionCheck > 60_000) {
          lastSessionCheck = Date.now();
          if (!(await this.sessions.isSessionValid(auth.sessionId))) {
            await sse.send('stream-error', { code: 'session_expired', message: 'Your session has ended' });
            break;
          }
        }
        if (!progressed) await waitFor((fn) => this.live.on(`deployment:${id}`, fn), sse, 2000);
      }
    } finally {
      sse.close();
    }
  }

  // ---- runtime logs ----

  private async runtimeTarget(auth: AuthContext, appId: string, deploymentId?: string) {
    const { app } = await this.access.app(auth, appId, 'logs.read');
    const targetId = deploymentId ?? app.activeDeploymentId;
    const d = targetId ? await this.prisma.deployment.findUnique({ where: { id: targetId } }) : null;
    if (!d || d.applicationId !== app.id || !d.containerId) throw notFound('Running container');
    const env = await this.env.resolve(d.envRevisionId);
    return { app, deployment: d, needles: redactionNeedles(env.secretValues) };
  }

  @Get('apps/:id/runtime-logs')
  @ApiOperation({ summary: 'Recent runtime stdout/stderr of the active (or given) deployment container' })
  async runtimeLogs(@Auth() auth: AuthContext, @Param('id') id: string, @Query('tail') tail?: string, @Query('deploymentId') deploymentId?: string): Promise<{ items: LogEvent[]; deploymentId: string } | { unavailable: string }> {
    const t = await this.runtimeTarget(auth, id, deploymentId);
    const n = Math.min(Math.max(Number.parseInt(tail ?? '500', 10) || 500, 1), 5000);
    const items: LogEvent[] = [];
    try {
      for await (const l of this.runner.logs(t.deployment.containerId!, { follow: false, tail: n })) {
        items.push({ id: l.ts, ts: l.ts, stream: l.stream, text: redactAll(l.text, t.needles) });
      }
    } catch (e) {
      if (e instanceof RunnerError && e.status === 404) return { unavailable: 'container_removed' };
      return { unavailable: 'runner_unreachable' };
    }
    return { items, deploymentId: t.deployment.id };
  }

  @Get('apps/:id/runtime-logs/stream')
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: 'SSE: follow runtime logs. Event ID is the Docker timestamp; reconnect resumes after it.' })
  async runtimeStream(@Auth() auth: AuthContext, @Param('id') id: string, @Req() req: Request, @Res() res: Response, @Query('tail') tail?: string, @Query('deploymentId') deploymentId?: string): Promise<void> {
    const t = await this.runtimeTarget(auth, id, deploymentId);
    const lastId = req.headers['last-event-id'] as string | undefined;
    const lastTs = lastId && !Number.isNaN(Date.parse(lastId)) ? lastId : undefined;
    const sse = SseStream.open(req, res, auth.userId);
    if (!sse) return;
    const abort = new AbortController();
    sse.onClose(() => abort.abort());
    const sessionTimer = setInterval(() => {
      void this.sessions.isSessionValid(auth.sessionId).then(async (ok) => {
        if (!ok) {
          await sse.send('stream-error', { code: 'session_expired', message: 'Your session has ended' });
          sse.close();
        }
      });
    }, 60_000);
    try {
      await sse.send('meta', { deploymentId: t.deployment.id, containerName: t.deployment.containerName });
      const opts = lastTs
        ? { follow: true, tail: 5000, since: Math.floor(Date.parse(lastTs) / 1000) }
        : { follow: true, tail: Math.min(Math.max(Number.parseInt(tail ?? '200', 10) || 200, 0), 2000) };
      for await (const l of this.runner.logs(t.deployment.containerId!, opts, abort.signal)) {
        // Docker's `since` has one-second granularity; skip lines already delivered.
        if (lastTs && l.ts <= lastTs) continue;
        await sse.send('log', { id: l.ts, ts: l.ts, stream: l.stream, text: redactAll(l.text, t.needles) }, l.ts);
        if (sse.closed) break;
      }
      await sse.send('end', { reason: 'container_stopped' });
    } catch (e) {
      if (!abort.signal.aborted) {
        await sse.send('stream-error', { code: e instanceof RunnerError && e.status === 404 ? 'container_removed' : 'runner_unreachable', message: 'Runtime log stream interrupted' });
      }
    } finally {
      clearInterval(sessionTimer);
      sse.close();
    }
  }
}
