import { Inject, Injectable, Logger } from '@nestjs/common';
import { ACTIVE_STATUSES, type ContainerSummary } from '@deployforge/contracts';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { RunnerClient } from '../runner/runner.client';
import { ProxyService } from '../proxy/proxy.service';
import { EnvService } from '../applications/env.service';
import { LiveService } from '../deployments/live.service';
import { CoordinationService } from './coordination.service';
import { DeploymentExecutor } from './deployment.executor';
import { QueuesService, jobIdFor } from './queues';
import { decideRetention } from './retention';
import type { ConfigSnapshot } from '../deployments/views';
import type { Prisma } from '../generated/prisma/client';

/**
 * Periodically converges actual state (containers, routes, images) with the
 * database, which is authoritative. Runs at worker startup and every
 * RECONCILE_INTERVAL_SECONDS. Only touches Docker objects labeled as owned by
 * DeployForge (enforced again by the runner).
 */
@Injectable()
export class ReconcilerService {
  private readonly logger = new Logger('Reconciler');
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: RunnerClient,
    private readonly proxy: ProxyService,
    private readonly env: EnvService,
    private readonly live: LiveService,
    private readonly coord: CoordinationService,
    private readonly executor: DeploymentExecutor,
    private readonly queues: QueuesService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async runOnce(): Promise<Record<string, number | string>> {
    if (this.running) return { skipped: 'already running' };
    this.running = true;
    const result: Record<string, number | string> = {};
    try {
      result.recoveredDeployments = await this.recoverStuckDeployments();
      result.requeued = await this.requeueQueued();
      const containers = await this.runner.listContainers();
      const c = await this.reconcileContainers(containers);
      Object.assign(result, c);
      await this.proxy.sync('reconcile');
      result.prunedImages = await this.applyRetention();
      result.expiredLogs = await this.expireLogs();
      await this.housekeeping();
      await this.record(true, result);
    } catch (e) {
      result.error = (e as Error).message;
      this.logger.warn(`reconcile failed: ${(e as Error).message}`);
      await this.record(false, result);
    } finally {
      this.running = false;
    }
    return result;
  }

  private async record(ok: boolean, result: Record<string, unknown>): Promise<void> {
    const value = { lastRunAt: new Date().toISOString(), ok, result } as Prisma.InputJsonValue;
    await this.prisma.platformState.upsert({ where: { key: 'reconciler' }, create: { key: 'reconciler', value }, update: { value } }).catch(() => undefined);
  }

  /** Deployments left in a running state by a dead worker (lease expired). */
  private async recoverStuckDeployments(): Promise<number> {
    const stuck = await this.prisma.deployment.findMany({
      where: { status: { in: ACTIVE_STATUSES.filter((s) => s !== 'queued') } },
      include: { application: true },
    });
    let n = 0;
    for (const d of stuck) {
      const app = d.application;
      const held = app.lockDeploymentId === d.id && app.lockExpiresAt && app.lockExpiresAt.getTime() > Date.now();
      if (held) continue;
      const token = await this.coord.acquire(app.id, d.id, 60);
      if (token === null) continue;
      try {
        const fresh = await this.prisma.deployment.findUniqueOrThrow({ where: { id: d.id } });
        const freshApp = await this.prisma.application.findUniqueOrThrow({ where: { id: app.id } });
        if (fresh.status !== 'queued' && ACTIVE_STATUSES.includes(fresh.status)) {
          await this.executor.recoverInterrupted(fresh, freshApp);
          n++;
        }
      } finally {
        await this.coord.release(app.id, d.id, token);
        await this.live.notifyApp(app.id);
      }
    }
    return n;
  }

  /** Re-add jobs for queued deployments (no-op if the job still exists: jobId dedupes). */
  private async requeueQueued(): Promise<number> {
    const queued = await this.prisma.deployment.findMany({ where: { status: 'queued', createdAt: { lt: new Date(Date.now() - 60_000) } }, select: { id: true } });
    for (const d of queued) {
      await this.queues.deployments.add('deployment.run', { deploymentId: d.id }, { jobId: jobIdFor(`deployment.run:${d.id}`) });
    }
    return queued.length;
  }

  private async reconcileContainers(containers: ContainerSummary[]): Promise<Record<string, number>> {
    const byId = new Map(containers.map((c) => [c.id, c]));
    const apps = await this.prisma.application.findMany({ where: { deletingAt: null, activeDeploymentId: { not: null } }, include: { activeDeployment: true } });
    let recreated = 0;
    let started = 0;
    let stopped = 0;
    for (const app of apps) {
      const d = app.activeDeployment!;
      const c = d.containerId ? byId.get(d.containerId) : undefined;
      if (app.lockDeploymentId && app.lockExpiresAt && app.lockExpiresAt.getTime() > Date.now()) continue; // an operation is in progress
      let observed = c?.state ?? 'missing';
      try {
        if (!c && app.desiredState === 'running' && d.imageId) {
          await this.recreate(app.id);
          recreated++;
          observed = 'running';
        } else if (c && app.desiredState === 'running' && !c.running && c.state !== 'restarting') {
          await this.runner.lifecycle(c.id, 'start');
          started++;
          observed = 'running';
        } else if (c && app.desiredState === 'stopped' && c.running) {
          await this.runner.lifecycle(c.id, 'stop', this.config.STOP_TIMEOUT_SECONDS);
          stopped++;
          observed = 'exited';
        }
      } catch (e) {
        this.logger.warn(`could not converge ${app.slug}: ${(e as Error).message}`);
      }
      if (observed !== app.observedState) {
        await this.prisma.application.update({ where: { id: app.id }, data: { observedState: observed, observedAt: new Date() } });
        await this.live.notifyApp(app.id);
      } else {
        await this.prisma.application.update({ where: { id: app.id }, data: { observedAt: new Date() } });
      }
    }

    // Orphans: owned containers that are neither active nor part of a live deployment.
    let removed = 0;
    const ids = containers.map((c) => c.labels['io.deployforge.deployment']).filter((x): x is string => !!x);
    const deps = new Map((await this.prisma.deployment.findMany({ where: { id: { in: ids } }, include: { application: true } })).map((d) => [d.id, d]));
    for (const c of containers) {
      const depId = c.labels['io.deployforge.deployment'];
      const d = depId ? deps.get(depId) : undefined;
      let orphan = false;
      if (!d) orphan = true;
      else if (d.application.activeDeploymentId === d.id) orphan = false;
      else if (ACTIVE_STATUSES.includes(d.status)) orphan = false;
      else if (d.status === 'succeeded') orphan = !!d.supersededAt && Date.now() - d.supersededAt.getTime() > (this.config.DRAIN_SECONDS + 120) * 1000;
      else orphan = true;
      if (orphan) {
        await this.runner.removeContainer(c.id, 5).catch(() => undefined);
        if (d?.status === 'succeeded') await this.prisma.deployment.update({ where: { id: d.id }, data: { retiredAt: new Date() } });
        removed++;
      }
    }
    return { recreated, started, stopped, removedOrphans: removed };
  }

  /** Recreate a missing active container from its immutable release. */
  private async recreate(applicationId: string): Promise<void> {
    const app = await this.prisma.application.findUniqueOrThrow({ where: { id: applicationId }, include: { activeDeployment: { include: { configRevision: true } } } });
    const d = app.activeDeployment!;
    const cfg = d.configRevision.config as unknown as ConfigSnapshot;
    const env = await this.env.resolve(d.envRevisionId);
    const net = await this.runner.ensureNetwork(app.workspaceId, app.id);
    const name = d.containerName ?? `df-${app.slug}-${d.number}-${d.id.slice(-8)}`;
    const created = await this.runner.createContainer({
      operationId: `recreate-${d.id}`,
      workspaceId: app.workspaceId,
      applicationId: app.id,
      deploymentId: d.id,
      name,
      image: d.imageId!,
      env: env.runtime,
      port: cfg.port,
      cpuLimit: cfg.cpuLimit,
      memoryLimitMb: cfg.memoryLimitMb,
      pidsLimit: this.config.PIDS_LIMIT,
      securityProfile: cfg.securityProfile,
      network: net.name,
    });
    await this.runner.promote(created.container.id);
    await this.prisma.deployment.update({ where: { id: d.id }, data: { containerId: created.container.id, containerName: name } });
    await this.prisma.deploymentEvent.create({ data: { deploymentId: d.id, type: 'reconciled', level: 'warn', message: 'Active container was missing; recreated from the release image by the reconciler' } });
  }

  private async applyRetention(): Promise<number> {
    const images = await this.runner.listImages();
    const byApp = new Map<string, typeof images>();
    for (const img of images) {
      const app = img.labels['io.deployforge.application'];
      if (!app) continue;
      byApp.set(app, [...(byApp.get(app) ?? []), img]);
    }
    let removed = 0;
    for (const [appId, imgs] of byApp) {
      const app = await this.prisma.application.findUnique({ where: { id: appId } });
      if (!app || app.deletingAt) continue; // deletion job handles these
      const deployments = await this.prisma.deployment.findMany({ where: { applicationId: appId }, select: { id: true, number: true, status: true, imageId: true, imagePrunedAt: true, pinned: true, finishedAt: true } });
      const decision = decideRetention({
        deployments,
        images: imgs.map((i) => ({ id: i.id, createdAt: new Date(i.createdAt) })),
        activeDeploymentId: app.activeDeploymentId,
        keep: this.config.RELEASES_TO_RETAIN,
        now: new Date(),
        graceMs: 3600_000,
      });
      for (const id of decision.removeImages) {
        try {
          await this.runner.removeImage(id);
          removed++;
        } catch (e) {
          this.logger.warn(`retention: could not remove ${id}: ${(e as Error).message}`);
        }
      }
      if (decision.markPruned.length) await this.prisma.deployment.updateMany({ where: { id: { in: decision.markPruned } }, data: { imagePrunedAt: new Date() } });
    }
    return removed;
  }

  /** Delete build logs older than LOG_RETENTION_DAYS (except the active release's). */
  private async expireLogs(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.LOG_RETENTION_DAYS * 86400_000);
    const old = await this.prisma.deployment.findMany({
      where: { finishedAt: { lt: cutoff }, logsExpiredAt: null, activeFor: null },
      select: { id: true },
      take: 200,
    });
    for (const d of old) {
      await this.prisma.$transaction([
        this.prisma.deploymentLog.deleteMany({ where: { deploymentId: d.id } }),
        this.prisma.deployment.update({ where: { id: d.id }, data: { logsExpiredAt: new Date() } }),
      ]);
    }
    return old.length;
  }

  private async housekeeping(): Promise<void> {
    const week = new Date(Date.now() - 7 * 86400_000);
    await this.prisma.outboxEvent.deleteMany({ where: { dispatchedAt: { lt: week } } });
    await this.prisma.webhookDelivery.deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - 30 * 86400_000) } } });
    await this.prisma.githubConnectState.deleteMany({ where: { expiresAt: { lt: week } } });
    await this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: week } } });
  }
}
