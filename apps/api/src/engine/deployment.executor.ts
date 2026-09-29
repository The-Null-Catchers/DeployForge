import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  FAILURE_EXPLANATIONS,
  isTerminal,
  redactAll,
  redactionNeedles,
  STAGES,
  type DeploymentStatus,
  type FailureCategory,
} from '@deployforge/contracts';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { RunnerClient, RunnerError } from '../runner/runner.client';
import { ProxyService } from '../proxy/proxy.service';
import { EnvService, type ResolvedEnv } from '../applications/env.service';
import { DeploymentsService } from '../deployments/deployments.service';
import { LiveService } from '../deployments/live.service';
import { CoordinationService } from './coordination.service';
import { OutboxService } from './outbox.service';
import type { ConfigSnapshot } from '../deployments/views';
import type { Application, Deployment } from '../generated/prisma/client';

/** Raised to stop the pipeline with a classified, user-facing failure. */
export class DeploymentFailure extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
  }
}
class Canceled extends Error {}
/** Another worker took over (lease lost, or status changed underneath us). */
class LostOwnership extends Error {}

interface Ctx {
  d: Deployment;
  app: Application;
  token: number;
  cfg: ConfigSnapshot;
  env: ResolvedEnv;
  needles: string[];
  leaseLost: boolean;
  candidateId: string | null;
  promoted: boolean;
}

export type RunResult = 'done' | 'busy';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class DeploymentExecutor {
  private readonly logger = new Logger('DeploymentExecutor');

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: RunnerClient,
    private readonly proxy: ProxyService,
    private readonly env: EnvService,
    private readonly coord: CoordinationService,
    private readonly outbox: OutboxService,
    private readonly live: LiveService,
    private readonly deployments: DeploymentsService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async run(deploymentId: string): Promise<RunResult> {
    const d = await this.prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (!d || isTerminal(d.status as DeploymentStatus)) return 'done';
    const token = await this.coord.acquire(d.applicationId, d.id, this.config.LEASE_SECONDS);
    if (token === null) return 'busy';
    const app = await this.prisma.application.findUniqueOrThrow({ where: { id: d.applicationId } });

    const heartbeat = setInterval(() => {
      void this.coord.renew(app.id, d.id, token, this.config.LEASE_SECONDS).then((ok) => {
        if (!ok && ctx) ctx.leaseLost = true;
      });
    }, Math.max(5, Math.floor(this.config.LEASE_SECONDS / 3)) * 1000);
    let ctx: Ctx | null = null;
    try {
      if (d.status !== 'queued') {
        // Redelivered after a worker crash: the previous attempt's process is
        // gone (its lease expired). Never resume mid-pipeline; settle state.
        await this.recoverInterrupted(d, app);
        return 'done';
      }
      if (app.deletingAt) {
        await this.finish(d, 'queued', 'canceled', { errorMessage: 'Application is being deleted' });
        return 'done';
      }
      const cfgRev = await this.prisma.configRevision.findUniqueOrThrow({ where: { id: d.configRevisionId } });
      const env = await this.env.resolve(d.envRevisionId);
      ctx = {
        d,
        app,
        token,
        cfg: cfgRev.config as unknown as ConfigSnapshot,
        env,
        needles: redactionNeedles(env.secretValues),
        leaseLost: false,
        candidateId: null,
        promoted: false,
      };
      await this.pipeline(ctx);
    } catch (e) {
      if (ctx) await this.handleError(ctx, e);
      else throw e;
    } finally {
      clearInterval(heartbeat);
      await this.coord.release(app.id, d.id, token);
      await this.live.notifyDeployment(d.id);
      await this.live.notifyApp(app.id);
    }
    return 'done';
  }

  // ---------------------------------------------------------------- pipeline

  private async pipeline(ctx: Ctx): Promise<void> {
    const { d } = ctx;
    await this.transition(ctx, 'queued', 'preparing', 'Preparing deployment');
    await this.prisma.deployment.update({ where: { id: d.id }, data: { startedAt: new Date(), attempts: { increment: 1 } } });
    const net = await this.runner.ensureNetwork(d.workspaceId, d.applicationId);

    let imageId: string;
    if (d.rollbackOfId) {
      imageId = await this.verifyRollbackImage(ctx);
      await this.transition(ctx, 'preparing', 'starting', 'Reusing release image (no rebuild)');
    } else {
      await this.checkpoint(ctx);
      await this.transition(ctx, 'preparing', 'cloning', `Cloning ${ctx.cfg.repoFullName} at ${d.commitSha?.slice(0, 12)}`);
      imageId = await this.build(ctx);
      await this.transition(ctx, 'building', 'starting', 'Starting candidate container');
    }
    await this.checkpoint(ctx);

    const containerName = `df-${ctx.app.slug}-${d.number}-${d.id.slice(-8)}`;
    const created = await this.runner.createContainer({
      operationId: `start-${d.id}`,
      workspaceId: d.workspaceId,
      applicationId: d.applicationId,
      deploymentId: d.id,
      name: containerName,
      image: imageId,
      env: ctx.env.runtime,
      port: ctx.cfg.port,
      cpuLimit: ctx.cfg.cpuLimit,
      memoryLimitMb: ctx.cfg.memoryLimitMb,
      pidsLimit: this.config.PIDS_LIMIT,
      securityProfile: ctx.cfg.securityProfile,
      network: net.name,
    });
    ctx.candidateId = created.container.id;
    await this.prisma.deployment.update({ where: { id: d.id }, data: { containerId: created.container.id, containerName } });
    await this.event(ctx, 'container_started', `Candidate container ${containerName} started`);

    await this.transition(ctx, 'starting', 'checking_health', `Checking health at ${ctx.cfg.healthCheck.path} on port ${ctx.cfg.port}`);
    await this.waitHealthy(ctx, created.container.id);

    // Last point at which cancellation is honored.
    await this.checkpoint(ctx);
    await this.transition(ctx, 'checking_health', 'promoting', 'Health checks passed; switching traffic');
    await this.promote(ctx, containerName);
  }

  private async verifyRollbackImage(ctx: Ctx): Promise<string> {
    const source = await this.prisma.deployment.findUnique({ where: { id: ctx.d.rollbackOfId! } });
    if (!source?.imageId || source.imagePrunedAt) throw new DeploymentFailure('release_unavailable', 'The release image was removed by retention');
    const images = await this.runner.listImages(ctx.d.applicationId);
    if (!images.some((i) => i.id === source.imageId)) {
      await this.prisma.deployment.update({ where: { id: source.id }, data: { imagePrunedAt: new Date() } });
      throw new DeploymentFailure('release_unavailable', 'The release image no longer exists on this server');
    }
    await this.prisma.deployment.update({ where: { id: ctx.d.id }, data: { imageId: source.imageId, imageTag: source.imageTag } });
    await this.event(ctx, 'rollback', `Rolling back to deployment #${source.number} using image ${source.imageId.slice(7, 19)} with config revision and environment revision from that release`);
    await this.event(ctx, 'rollback_notice', 'Note: an older environment revision may contain expired or revoked credentials. Rollback does not reverse database migrations or external side effects.', 'warn');
    return source.imageId;
  }

  private async build(ctx: Ctx): Promise<string> {
    const { d } = ctx;
    const auth = await this.deployments.repoAuth(ctx.cfg as unknown as Application).catch((e: Error) => {
      throw new DeploymentFailure('clone_failed', `Could not obtain repository credentials: ${e.message}`);
    });
    const opId = `build-${d.id}`;
    const request = {
      operationId: opId,
      workspaceId: d.workspaceId,
      applicationId: d.applicationId,
      deploymentId: d.id,
      repository: { cloneUrl: ctx.cfg.repoUrl, commitSha: d.commitSha!, ...(auth ? { auth } : {}) },
      contextDir: ctx.cfg.contextDir,
      dockerfilePath: ctx.cfg.dockerfilePath,
      buildArgs: ctx.env.buildArgs,
      buildSecrets: ctx.env.buildSecrets,
      imageTag: `deployforge/${d.applicationId}:${d.id}`,
      timeoutSeconds: this.config.BUILD_TIMEOUT_SECONDS,
      redact: ctx.env.secretValues.filter((s) => s.length >= 6),
    };
    if (auth) ctx.needles = redactionNeedles([...ctx.env.secretValues, auth.token]);
    try {
      await this.runner.submitBuild(request);
    } catch (e) {
      throw this.runnerFailure(e, 'build');
    }
    let after = 0;
    let phase = 'cloning';
    let resubmits = 0;
    let cancelSent = false;
    for (;;) {
      if (ctx.leaseLost) throw new LostOwnership();
      let st;
      try {
        st = await this.runner.buildStatus(opId, after);
      } catch (e) {
        if (e instanceof RunnerError && e.code === 'operation_not_found' && resubmits < 1) {
          // Runner restarted and lost the in-memory operation; builds are
          // deterministic for an exact commit, so resubmit once.
          resubmits++;
          await this.systemLog(ctx, 'Runner restarted during the build; restarting the build once');
          await this.runner.submitBuild(request);
          after = 0;
          continue;
        }
        throw this.runnerFailure(e, 'build');
      }
      if (st.logs.length > 0) {
        await this.appendLogs(ctx, st.logs.map((l) => ({ ts: l.ts, stream: l.stream, text: l.text })));
        after = st.nextSeq;
      }
      if (st.phase === 'building' && phase === 'cloning') {
        phase = 'building';
        await this.transition(ctx, 'cloning', 'building', 'Building image with BuildKit');
      }
      if (st.commitMessage && !d.commitMessage) {
        d.commitMessage = st.commitMessage;
        await this.prisma.deployment.update({ where: { id: d.id }, data: { commitMessage: st.commitMessage.slice(0, 300) } });
      }
      if (st.state === 'succeeded' && st.imageId) {
        if (phase === 'cloning') await this.transition(ctx, 'cloning', 'building', 'Building image with BuildKit');
        await this.prisma.deployment.update({ where: { id: d.id }, data: { imageId: st.imageId, imageTag: request.imageTag } });
        await this.event(ctx, 'image_built', `Image ${st.imageId.slice(7, 19)} built`);
        return st.imageId;
      }
      if (st.state === 'failed' || st.state === 'canceled') {
        if (st.state === 'canceled' || st.failureKind === 'canceled') throw new Canceled();
        const category: FailureCategory =
          st.failureKind === 'clone' ? 'clone_failed' : st.failureKind === 'config' ? 'config_invalid' : st.failureKind === 'timeout' ? 'build_timeout' : st.failureKind === 'internal' ? 'internal_error' : 'build_failed';
        throw new DeploymentFailure(category, redactAll(st.error?.message ?? 'Build failed', ctx.needles));
      }
      if (!cancelSent && (await this.cancelRequested(ctx))) {
        cancelSent = true;
        await this.systemLog(ctx, 'Cancellation requested; stopping the build');
        await this.runner.cancelBuild(opId).catch(() => undefined);
      }
      await sleep(1000);
    }
  }

  private async waitHealthy(ctx: Ctx, containerId: string): Promise<void> {
    const hc = ctx.cfg.healthCheck;
    const startDeadline = Date.now() + hc.startPeriodSeconds * 1000;
    while (Date.now() < startDeadline) {
      await this.checkpoint(ctx);
      const s = await this.runner.inspect(containerId);
      if (!s.running) await this.crashed(ctx, containerId, s.exitCode, s.oomKilled);
      await sleep(Math.min(1000, Math.max(0, startDeadline - Date.now())));
    }
    let last = '';
    for (let attempt = 1; attempt <= hc.retries; attempt++) {
      await this.checkpoint(ctx);
      const r = await this.runner.probe(containerId, { port: ctx.cfg.port, path: hc.path, timeoutMs: hc.timeoutSeconds * 1000 });
      if (!r.container.running) await this.crashed(ctx, containerId, r.container.exitCode, r.container.oomKilled);
      if (r.ok) {
        await this.event(ctx, 'healthy', `Health check passed (HTTP ${r.statusCode}, ${r.durationMs}ms, attempt ${attempt})`);
        return;
      }
      last = r.error ?? `HTTP ${r.statusCode}`;
      await this.systemLog(ctx, `Health check attempt ${attempt}/${hc.retries} failed: ${last}`);
      await sleep(hc.intervalSeconds * 1000);
    }
    await this.captureRuntimeLogs(ctx, containerId);
    throw new DeploymentFailure('health_check_failed', `Health check ${hc.path} on port ${ctx.cfg.port} did not pass after ${hc.retries} attempts: ${last}`);
  }

  private async crashed(ctx: Ctx, containerId: string, exitCode: number, oom: boolean): Promise<never> {
    await this.captureRuntimeLogs(ctx, containerId);
    throw new DeploymentFailure(
      'startup_crash',
      oom ? `Container was killed for exceeding its ${ctx.cfg.memoryLimitMb} MB memory limit` : `Container exited with code ${exitCode} before becoming healthy`,
    );
  }

  /** Copy the candidate's last output into the deployment log for diagnosis. */
  private async captureRuntimeLogs(ctx: Ctx, containerId: string): Promise<void> {
    try {
      const lines: { ts: string; stream: string; text: string }[] = [];
      for await (const l of this.runner.logs(containerId, { follow: false, tail: 100 })) lines.push(l);
      await this.systemLog(ctx, lines.length ? `---- last ${lines.length} lines of container output ----` : 'Container produced no output');
      await this.appendLogs(ctx, lines);
    } catch {
      await this.systemLog(ctx, 'Could not read container output');
    }
  }

  private async promote(ctx: Ctx, containerName: string): Promise<void> {
    const { d, app } = ctx;
    await this.runner.promote(ctx.candidateId!);
    let previousActiveId: string | null = null;
    try {
      previousActiveId = await this.proxy.promote(
        { applicationId: app.id, containerName, port: ctx.cfg.port },
        ctx.cfg.healthCheck.path,
        async (tx) => {
          const [row] = await tx.$queryRaw<{ lockDeploymentId: string | null; lockToken: number }[]>`
            SELECT "lockDeploymentId", "lockToken" FROM "Application" WHERE id = ${app.id}`;
          if (!row || row.lockDeploymentId !== d.id || row.lockToken !== ctx.token || ctx.leaseLost) throw new LostOwnership();
        },
        async (tx) => {
          // Fenced commit: only the current lease holder may promote, and
          // never over a newer active release.
          const [row] = await tx.$queryRaw<{ lockDeploymentId: string | null; lockToken: number; activeDeploymentId: string | null }[]>`
            SELECT "lockDeploymentId", "lockToken", "activeDeploymentId" FROM "Application" WHERE id = ${app.id} FOR UPDATE`;
          if (!row || row.lockDeploymentId !== d.id || row.lockToken !== ctx.token) throw new LostOwnership();
          if (row.activeDeploymentId) {
            const current = await tx.deployment.findUniqueOrThrow({ where: { id: row.activeDeploymentId } });
            if (current.number > d.number) throw new DeploymentFailure('superseded', `Deployment #${current.number} is newer and already active`);
            await tx.deployment.update({ where: { id: current.id }, data: { releaseState: 'superseded', supersededAt: new Date() } });
          }
          const moved = await tx.deployment.updateMany({ where: { id: d.id, status: 'promoting' }, data: { releaseState: 'active', promotedAt: new Date() } });
          if (moved.count !== 1) throw new LostOwnership();
          await tx.application.update({ where: { id: app.id }, data: { activeDeploymentId: d.id, desiredState: 'running', observedState: 'running', observedAt: new Date() } });
          return row.activeDeploymentId;
        },
      );
    } catch (e) {
      // Restore routing from the database, which still names the previous release.
      await this.proxy.sync('restore-after-failed-promotion').catch((err: Error) => this.logger.error(`route restore failed: ${err.message}`));
      if (e instanceof LostOwnership || e instanceof DeploymentFailure) throw e;
      throw new DeploymentFailure('proxy_promotion_failed', (e as Error).message);
    }
    ctx.promoted = true;
    await this.event(ctx, 'promoted', `Traffic now routed to deployment #${d.number}; verified through the proxy`);
    await this.finish(d, 'promoting', 'succeeded', {});
    if (previousActiveId) {
      await this.prisma.$transaction(async (tx) =>
        this.outbox.add(tx, 'container.retire', { deploymentId: previousActiveId }, { dedupeKey: `retire:${previousActiveId}:${d.id}`, delayMs: this.config.DRAIN_SECONDS * 1000 }),
      );
      await this.outbox.notify();
      await this.event(ctx, 'draining', `Previous release will be stopped after a ${this.config.DRAIN_SECONDS}s drain period`);
    }
    await this.audit.record({ workspaceId: d.workspaceId, actorId: d.actorId, action: 'deployment.succeeded', targetType: 'deployment', targetId: d.id, metadata: { number: d.number, application: app.slug } });
  }

  // ----------------------------------------------------------- error paths

  private async handleError(ctx: Ctx, e: unknown): Promise<void> {
    const current = await this.prisma.deployment.findUniqueOrThrow({ where: { id: ctx.d.id } });
    const status = current.status as DeploymentStatus;
    if (e instanceof LostOwnership) {
      this.logger.warn(`deployment ${ctx.d.id}: lost ownership; another worker is responsible now`);
      return;
    }
    if (isTerminal(status)) return;
    if (!ctx.promoted && ctx.candidateId) {
      await this.runner.removeContainer(ctx.candidateId, 5).catch((err: Error) => this.logger.warn(`candidate cleanup failed: ${err.message}`));
    }
    if (e instanceof Canceled) {
      await this.finish(current, status, 'canceled', { errorMessage: 'Canceled by user' });
      await this.event(ctx, 'canceled', 'Deployment canceled; the active release was not changed', 'warn');
      return;
    }
    let category: FailureCategory = 'internal_error';
    let message = 'Unexpected error';
    if (e instanceof DeploymentFailure) {
      category = e.category;
      message = e.message;
    } else if (e instanceof RunnerError) {
      const f = this.runnerFailure(e, status);
      category = f.category;
      message = f.message;
    } else {
      this.logger.error({ err: e, deployment: ctx.d.id }, 'deployment failed unexpectedly');
      message = (e as Error).message ?? message;
    }
    message = redactAll(message, ctx.needles).slice(0, 2000);
    await this.finish(current, status, 'failed', { failureCategory: category, failureStage: status, errorMessage: message });
    await this.event(ctx, 'failed', `${FAILURE_EXPLANATIONS[category].title}: ${message}`, 'error');
    await this.event(ctx, 'unchanged', ctx.app.activeDeploymentId ? 'The previously active release keeps serving traffic' : 'No release was active; nothing is serving yet', 'info');
    await this.audit.record({ workspaceId: ctx.d.workspaceId, actorId: ctx.d.actorId, action: 'deployment.failed', targetType: 'deployment', targetId: ctx.d.id, metadata: { category, stage: status } });
  }

  private runnerFailure(e: unknown, stage: string): DeploymentFailure {
    if (e instanceof DeploymentFailure) return e;
    if (e instanceof RunnerError) {
      if (e.status === 0 || e.status >= 502) return new DeploymentFailure('runner_unavailable', `Runner unavailable during ${stage}: ${e.message}`);
      if (e.code === 'image_not_found') return new DeploymentFailure('release_unavailable', e.message);
      return new DeploymentFailure('internal_error', `Runner rejected ${stage}: ${e.message}`);
    }
    return new DeploymentFailure('internal_error', (e as Error).message);
  }

  /** Settle a deployment whose previous worker died mid-pipeline. */
  async recoverInterrupted(d: Deployment, app: Application): Promise<void> {
    const status = d.status as DeploymentStatus;
    if (app.activeDeploymentId === d.id) {
      // The promotion committed before the crash; only the final status write was lost.
      await this.finish(d, status, 'succeeded', {});
      await this.systemEvent(d.id, 'recovered', 'Worker restarted after promotion committed; marked succeeded');
      return;
    }
    if (d.containerId) await this.runner.removeContainer(d.containerId, 5).catch(() => undefined);
    await this.finish(d, status, 'interrupted', { failureStage: status, errorMessage: 'The deployment worker stopped unexpectedly. The previously active release was not changed. Deploy again to retry.' });
    await this.systemEvent(d.id, 'interrupted', 'Deployment interrupted by a worker restart; the active release was not changed', 'warn');
    if (status === 'promoting') await this.proxy.sync('recover-interrupted-promotion').catch(() => undefined);
  }

  // --------------------------------------------------------------- helpers

  private async checkpoint(ctx: Ctx): Promise<void> {
    if (ctx.leaseLost) throw new LostOwnership();
    if (await this.cancelRequested(ctx)) throw new Canceled();
  }

  private async cancelRequested(ctx: Ctx): Promise<boolean> {
    const row = await this.prisma.deployment.findUnique({ where: { id: ctx.d.id }, select: { cancelRequestedAt: true } });
    return !!row?.cancelRequestedAt;
  }

  /** Conditional status transition: fails if another actor changed the status. */
  private async transition(ctx: Ctx, from: DeploymentStatus, to: DeploymentStatus, message: string): Promise<void> {
    if (ctx.leaseLost) throw new LostOwnership();
    const now = new Date();
    const r = await this.prisma.deployment.updateMany({ where: { id: ctx.d.id, status: from }, data: { status: to } });
    if (r.count !== 1) throw new LostOwnership();
    ctx.d.status = to;
    await this.prisma.deploymentStage.updateMany({ where: { deploymentId: ctx.d.id, finishedAt: null }, data: { finishedAt: now, outcome: 'succeeded' } });
    if ((STAGES as readonly string[]).includes(to)) await this.prisma.deploymentStage.create({ data: { deploymentId: ctx.d.id, stage: to, startedAt: now } });
    await this.event(ctx, `stage:${to}`, message);
  }

  private async finish(d: Deployment, from: DeploymentStatus, to: 'succeeded' | 'failed' | 'canceled' | 'interrupted', data: { failureCategory?: string; failureStage?: string; errorMessage?: string }): Promise<void> {
    const now = new Date();
    const r = await this.prisma.deployment.updateMany({ where: { id: d.id, status: from }, data: { status: to, finishedAt: now, ...data } });
    if (r.count === 1) {
      await this.prisma.deploymentStage.updateMany({
        where: { deploymentId: d.id, finishedAt: null },
        data: { finishedAt: now, outcome: to === 'succeeded' ? 'succeeded' : to === 'canceled' ? 'canceled' : 'failed' },
      });
    }
    await this.live.notifyDeployment(d.id);
  }

  private async event(ctx: Ctx, type: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    await this.systemEvent(ctx.d.id, type, redactAll(message, ctx.needles), level);
  }

  private async systemEvent(deploymentId: string, type: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    await this.prisma.deploymentEvent.create({ data: { deploymentId, type, level, message: message.slice(0, 4000) } });
    await this.live.notifyDeployment(deploymentId);
  }

  private async systemLog(ctx: Ctx, text: string): Promise<void> {
    await this.appendLogs(ctx, [{ ts: new Date().toISOString(), stream: 'system', text }]);
  }

  /** Persist redacted log lines within the per-deployment line/byte budget. */
  private async appendLogs(ctx: Ctx, lines: { ts: string; stream: string; text: string }[]): Promise<void> {
    if (lines.length === 0) return;
    const d = await this.prisma.deployment.findUniqueOrThrow({ where: { id: ctx.d.id }, select: { logLines: true, logBytes: true, logsTruncated: true } });
    if (d.logsTruncated) return;
    const rows: { deploymentId: string; ts: Date; stream: string; text: string }[] = [];
    let n = d.logLines;
    let bytes = d.logBytes;
    let truncated = false;
    for (const l of lines) {
      const text = redactAll(l.text, ctx.needles);
      const size = Buffer.byteLength(text);
      if (n + 1 > this.config.MAX_BUILD_LOG_LINES || bytes + size > this.config.MAX_BUILD_LOG_BYTES) {
        truncated = true;
        break;
      }
      const ts = new Date(l.ts);
      rows.push({ deploymentId: ctx.d.id, ts: Number.isNaN(ts.getTime()) ? new Date() : ts, stream: ['stdout', 'stderr', 'system'].includes(l.stream) ? l.stream : 'stdout', text });
      n++;
      bytes += size;
    }
    if (truncated) {
      rows.push({ deploymentId: ctx.d.id, ts: new Date(), stream: 'system', text: `Log limit reached (${this.config.MAX_BUILD_LOG_LINES} lines / ${Math.round(this.config.MAX_BUILD_LOG_BYTES / 1048576)} MiB); further output is not stored` });
    }
    await this.prisma.$transaction([
      this.prisma.deploymentLog.createMany({ data: rows }),
      this.prisma.deployment.update({ where: { id: ctx.d.id }, data: { logLines: n, logBytes: bytes, logsTruncated: truncated } }),
    ]);
    await this.live.notifyDeployment(ctx.d.id);
  }
}
