import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  parseRepoUrl,
  RESERVED_SLUGS,
  type ApplicationSummary,
  type ApplicationView,
  type CreateApplicationRequest,
  type MetricsView,
} from '@deployforge/contracts';
import type { z } from 'zod';
import type { updateApplicationRequestSchema } from '@deployforge/contracts';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { conflict, notFound } from '../common/errors';
import { GITHUB_CLIENT } from '../github/github.module';
import type { GithubClient } from '../github/github.client';
import { OutboxService } from '../engine/outbox.service';
import { CoordinationService } from '../engine/coordination.service';
import { RunnerClient } from '../runner/runner.client';
import { EnvService } from './env.service';
import { appSummary, appView, platformHostname, snapshotOf } from '../deployments/views';
import type { Application, Prisma } from '../generated/prisma/client';
import type { RequestMeta } from '../auth/auth.types';
import { LiveService } from '../deployments/live.service';

const unprocessable = (message: string, code: string) =>
  new UnprocessableEntityException({ statusCode: 422, error: 'Unprocessable Entity', code, message });

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly env: EnvService,
    private readonly outbox: OutboxService,
    private readonly coord: CoordinationService,
    private readonly runner: RunnerClient,
    private readonly live: LiveService,
    @Inject(GITHUB_CLIENT) private readonly github: GithubClient | null,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async summariesForWorkspace(workspaceId: string): Promise<ApplicationSummary[]> {
    const apps = await this.prisma.application.findMany({ where: { workspaceId, deletingAt: null }, orderBy: { createdAt: 'asc' }, include: { activeDeployment: true } });
    const latest = await this.latestDeployments(apps.map((a) => a.id));
    return apps.map((a) => appSummary(this.config, a, a.activeDeployment, latest.get(a.id) ?? null));
  }

  private async latestDeployments(appIds: string[]) {
    if (appIds.length === 0) return new Map();
    const rows = await this.prisma.deployment.findMany({ where: { applicationId: { in: appIds } }, orderBy: { number: 'desc' }, distinct: ['applicationId'] });
    return new Map(rows.map((d) => [d.applicationId, d]));
  }

  async view(app: Application): Promise<ApplicationView> {
    const active = app.activeDeploymentId
      ? await this.prisma.deployment.findUnique({ where: { id: app.activeDeploymentId }, include: { configRevision: true, envRevision: true } })
      : null;
    const latest = await this.prisma.deployment.findFirst({ where: { applicationId: app.id }, orderBy: { number: 'desc' } });
    const cfg = app.currentConfigRevisionId ? await this.prisma.configRevision.findUnique({ where: { id: app.currentConfigRevisionId } }) : null;
    const env = app.currentEnvRevisionId ? await this.prisma.envRevision.findUnique({ where: { id: app.currentEnvRevisionId } }) : null;
    return appView(this.config, app, active, latest, cfg, env);
  }

  async create(workspaceId: string, actorId: string, input: CreateApplicationRequest, meta: RequestMeta): Promise<Application> {
    const project = await this.prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project || project.workspaceId !== workspaceId) throw notFound('Project');
    if (RESERVED_SLUGS.has(input.slug)) throw conflict('This slug is reserved', 'slug_reserved');

    let source: Pick<Application, 'sourceType' | 'repoUrl' | 'repoFullName' | 'githubInstallationId' | 'githubRepositoryId'>;
    if (input.source.type === 'public') {
      const parsed = parseRepoUrl(input.source.repoUrl, this.config.GIT_EXTRA_ALLOWED_HOSTS);
      if (!parsed) throw unprocessable('Only public https://github.com/<owner>/<repo> URLs are supported', 'unsupported_repository');
      source = { sourceType: 'public', repoUrl: parsed.cloneUrl, repoFullName: parsed.fullName, githubInstallationId: null, githubRepositoryId: null };
    } else {
      if (!this.github) throw unprocessable('GitHub integration is not configured on this server', 'github_unavailable');
      // The installation must belong to this workspace, and GitHub must
      // confirm the installation can access the repository.
      const inst = await this.prisma.githubInstallation.findUnique({ where: { id: input.source.installationId } });
      if (!inst || inst.workspaceId !== workspaceId || inst.status !== 'active') throw notFound('GitHub installation');
      const repo = await this.github.getRepo(inst.githubInstallationId, input.source.repositoryId);
      if (!repo) throw unprocessable('The GitHub App installation cannot access that repository', 'repository_inaccessible');
      const parsed = parseRepoUrl(repo.cloneUrl, this.config.GIT_EXTRA_ALLOWED_HOSTS);
      if (!parsed) throw unprocessable('Unsupported repository host', 'unsupported_repository');
      source = { sourceType: 'github', repoUrl: parsed.cloneUrl, repoFullName: repo.fullName, githubInstallationId: inst.id, githubRepositoryId: repo.id };
    }

    const hostname = platformHostname(this.config, input.slug);
    const app = await this.prisma.$transaction(async (tx) => {
      if (await tx.domain.findUnique({ where: { hostname } })) throw conflict('That hostname is already in use', 'hostname_taken');
      const created = await tx.application.create({
        data: {
          workspaceId,
          projectId: project.id,
          name: input.name,
          slug: input.slug,
          ...source,
          branch: input.branch,
          contextDir: input.contextDir,
          dockerfilePath: input.dockerfilePath,
          port: input.port,
          healthPath: input.healthCheck.path,
          healthTimeoutSeconds: input.healthCheck.timeoutSeconds,
          healthIntervalSeconds: input.healthCheck.intervalSeconds,
          healthStartPeriodSeconds: input.healthCheck.startPeriodSeconds,
          healthRetries: input.healthCheck.retries,
          cpuLimit: input.cpuLimit,
          memoryLimitMb: input.memoryLimitMb,
          autoDeploy: input.autoDeploy,
          securityProfile: input.securityProfile,
        },
      });
      const cfg = await tx.configRevision.create({ data: { applicationId: created.id, number: 1, config: snapshotOf(created) as unknown as Prisma.InputJsonValue, createdById: actorId } });
      const entries = this.env.encryptEntries(created.id, input.env);
      const envRev = await tx.envRevision.create({ data: { applicationId: created.id, number: 1, entries: entries as unknown as Prisma.InputJsonValue, createdById: actorId } });
      await tx.domain.create({ data: { workspaceId, applicationId: created.id, hostname, kind: 'platform', status: 'active' } });
      const updated = await tx.application.update({ where: { id: created.id }, data: { currentConfigRevisionId: cfg.id, currentEnvRevisionId: envRev.id } });
      await this.audit.record(
        {
          workspaceId,
          actorId,
          action: 'application.created',
          targetType: 'application',
          targetId: created.id,
          metadata: { slug: created.slug, repo: created.repoFullName, envKeys: input.env.map((e) => e.key) },
          meta,
        },
        tx,
      );
      return updated;
    });
    return app;
  }

  async update(app: Application, actorId: string, patch: z.infer<typeof updateApplicationRequestSchema>, meta: RequestMeta): Promise<Application> {
    const data: Prisma.ApplicationUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.branch !== undefined) data.branch = patch.branch;
    if (patch.contextDir !== undefined) data.contextDir = patch.contextDir;
    if (patch.dockerfilePath !== undefined) data.dockerfilePath = patch.dockerfilePath;
    if (patch.port !== undefined) data.port = patch.port;
    if (patch.cpuLimit !== undefined) data.cpuLimit = patch.cpuLimit;
    if (patch.memoryLimitMb !== undefined) data.memoryLimitMb = patch.memoryLimitMb;
    if (patch.autoDeploy !== undefined) data.autoDeploy = patch.autoDeploy;
    if (patch.securityProfile !== undefined) data.securityProfile = patch.securityProfile;
    if (patch.healthCheck) {
      data.healthPath = patch.healthCheck.path;
      data.healthTimeoutSeconds = patch.healthCheck.timeoutSeconds;
      data.healthIntervalSeconds = patch.healthCheck.intervalSeconds;
      data.healthStartPeriodSeconds = patch.healthCheck.startPeriodSeconds;
      data.healthRetries = patch.healthCheck.retries;
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Application" WHERE id = ${app.id} FOR UPDATE`;
      const next = await tx.application.update({ where: { id: app.id }, data });
      const configChanged = JSON.stringify(snapshotOf(next)) !== JSON.stringify(snapshotOf(app));
      if (configChanged) {
        const last = await tx.configRevision.findFirst({ where: { applicationId: app.id }, orderBy: { number: 'desc' } });
        const rev = await tx.configRevision.create({
          data: { applicationId: app.id, number: (last?.number ?? 0) + 1, config: snapshotOf(next) as unknown as Prisma.InputJsonValue, createdById: actorId },
        });
        await tx.application.update({ where: { id: app.id }, data: { currentConfigRevisionId: rev.id } });
      }
      await this.audit.record({ workspaceId: app.workspaceId, actorId, action: 'application.updated', targetType: 'application', targetId: app.id, metadata: { fields: Object.keys(patch) }, meta }, tx);
      return tx.application.findUniqueOrThrow({ where: { id: app.id } });
    });
    if (patch.autoDeploy !== undefined && patch.autoDeploy !== app.autoDeploy) {
      await this.audit.record({ workspaceId: app.workspaceId, actorId, action: patch.autoDeploy ? 'application.autodeploy_enabled' : 'application.autodeploy_disabled', targetType: 'application', targetId: app.id, meta });
    }
    return updated;
  }

  /**
   * Stop/start/restart the active release. Runs under the application lease
   * so it cannot interleave with a deployment's promotion.
   */
  async lifecycle(app: Application, action: 'start' | 'stop' | 'restart', actorId: string, meta: RequestMeta): Promise<Application> {
    const active = app.activeDeploymentId ? await this.prisma.deployment.findUnique({ where: { id: app.activeDeploymentId } }) : null;
    if (!active?.containerId) throw unprocessable('This application has no active release yet', 'not_deployed');
    const holder = `op-${randomBytes(6).toString('hex')}`;
    const token = await this.coord.acquire(app.id, holder, 120);
    if (token === null) throw conflict('A deployment or another operation is in progress for this application. Try again when it finishes.', 'busy');
    try {
      const desiredState = action === 'stop' ? 'stopped' : 'running';
      await this.prisma.application.update({ where: { id: app.id }, data: { desiredState } });
      if (action === 'start') {
        await this.runner.lifecycle(active.containerId, 'start');
      } else {
        await this.runner.lifecycle(active.containerId, action, this.config.STOP_TIMEOUT_SECONDS);
      }
      const summary = await this.runner.inspect(active.containerId).catch(() => null);
      await this.prisma.application.update({ where: { id: app.id }, data: { observedState: summary ? summary.state : 'unknown', observedAt: new Date() } });
      await this.audit.record({ workspaceId: app.workspaceId, actorId, action: `application.${action}`, targetType: 'application', targetId: app.id, meta });
      // Stopped applications get a 503 route instead of an upstream.
      await this.prisma.$transaction(async (tx) => this.outbox.add(tx, 'routes.sync', { reason: `lifecycle:${action}` }));
      await this.outbox.notify();
    } finally {
      await this.coord.release(app.id, holder, token);
    }
    await this.live.notifyApp(app.id);
    return this.prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  }

  /** Deletion is asynchronous: hide immediately, then the worker removes routes and owned resources. */
  async requestDelete(app: Application, actorId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.application.updateMany({ where: { id: app.id, deletingAt: null }, data: { deletingAt: new Date(), autoDeploy: false } });
      if (r.count === 0) throw notFound('Application');
      await tx.deployment.updateMany({
        where: { applicationId: app.id, status: 'queued' },
        data: { status: 'canceled', finishedAt: new Date(), errorMessage: 'Application deleted' },
      });
      await tx.deployment.updateMany({ where: { applicationId: app.id, status: { notIn: ['queued', 'succeeded', 'failed', 'canceled', 'interrupted'] } }, data: { cancelRequestedAt: new Date() } });
      await this.outbox.add(tx, 'app.delete', { applicationId: app.id }, { dedupeKey: `app.delete:${app.id}` });
      await this.audit.record({ workspaceId: app.workspaceId, actorId, action: 'application.deleted', targetType: 'application', targetId: app.id, metadata: { slug: app.slug }, meta }, tx);
    });
    await this.outbox.notify();
  }

  async metrics(app: Application): Promise<MetricsView | null> {
    const active = app.activeDeploymentId ? await this.prisma.deployment.findUnique({ where: { id: app.activeDeploymentId } }) : null;
    if (!active?.containerId) return null;
    const latestFinished = await this.prisma.deployment.findFirst({
      where: { applicationId: app.id, status: 'succeeded', startedAt: { not: null }, finishedAt: { not: null } },
      orderBy: { number: 'desc' },
    });
    const stats = await this.runner.stats(active.containerId);
    let health: MetricsView['health'] = stats.running ? 'unknown' : 'stopped';
    if (stats.running) {
      const probe = await this.runner
        .probe(active.containerId, { port: app.port, path: app.healthPath, timeoutMs: Math.min(app.healthTimeoutSeconds, 5) * 1000 })
        .catch(() => null);
      health = probe ? (probe.ok ? 'healthy' : 'unhealthy') : 'unknown';
    }
    return {
      sampledAt: stats.sampledAt,
      sampleIntervalNote: 'Point-in-time sample. CPU is averaged over the ~1s window Docker uses between two readings; 100% equals one full CPU core.',
      cpuPercent: Math.round(stats.cpuPercent * 10) / 10,
      cpuLimitCores: app.cpuLimit,
      memoryBytes: stats.memoryBytes,
      memoryLimitBytes: stats.memoryLimitBytes,
      pids: stats.pids,
      running: stats.running,
      uptimeSeconds: stats.running && stats.startedAt ? Math.max(0, Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000)) : null,
      restartCount: stats.restartCount,
      health,
      latestDeploymentDurationMs: latestFinished ? latestFinished.finishedAt!.getTime() - latestFinished.startedAt!.getTime() : null,
    };
  }
}
