import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { isCancelable, isTerminal, type DeploymentStatus, type DeploymentTrigger } from '@deployforge/contracts';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { conflict, notFound } from '../common/errors';
import { OutboxService } from '../engine/outbox.service';
import { RunnerClient, RunnerError } from '../runner/runner.client';
import { GITHUB_CLIENT } from '../github/github.module';
import type { GithubClient } from '../github/github.client';
import type { Application, Deployment } from '../generated/prisma/client';
import type { RequestMeta } from '../auth/auth.types';
import { LiveService } from './live.service';

const unprocessable = (message: string, code: string) =>
  new UnprocessableEntityException({ statusCode: 422, error: 'Unprocessable Entity', code, message });

export interface CreateDeploymentInput {
  trigger: DeploymentTrigger;
  actorId: string | null;
  commitSha?: string;
  commitMessage?: string;
  rollbackOf?: Deployment;
  idempotencyKey?: string;
  meta?: RequestMeta;
}

@Injectable()
export class DeploymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly runner: RunnerClient,
    private readonly live: LiveService,
    @Inject(GITHUB_CLIENT) private readonly github: GithubClient | null,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Credentials for cloning an app's repository (GitHub App apps only). */
  async repoAuth(app: Pick<Application, 'sourceType' | 'githubInstallationId' | 'githubRepositoryId'>): Promise<{ username: string; token: string } | undefined> {
    if (app.sourceType !== 'github') return undefined;
    if (!this.github || !app.githubInstallationId || !app.githubRepositoryId) throw unprocessable('GitHub integration is not configured', 'github_unavailable');
    const inst = await this.prisma.githubInstallation.findUnique({ where: { id: app.githubInstallationId } });
    if (!inst || inst.status !== 'active') throw unprocessable('The GitHub App installation for this repository is disconnected', 'installation_disconnected');
    const token = await this.github.repoToken(inst.githubInstallationId, app.githubRepositoryId);
    return { username: 'x-access-token', token };
  }

  /** Resolve the branch head once so the deployment records an exact SHA. */
  async resolveCommit(app: Application): Promise<string> {
    const auth = await this.repoAuth(app);
    try {
      const r = await this.runner.gitResolve(app.repoUrl, app.branch, auth);
      if (!r.found) throw unprocessable(`Branch "${app.branch}" was not found in ${app.repoFullName}`, 'branch_not_found');
      return r.commitSha;
    } catch (e) {
      if (e instanceof RunnerError) {
        if (e.code === 'url_not_allowed') throw unprocessable('Repository URL is not allowed', 'repo_not_allowed');
        throw unprocessable(`Could not reach the repository: ${e.message}`, e.status === 0 ? 'runner_unavailable' : 'repository_unreachable');
      }
      throw e;
    }
  }

  /**
   * Persist a deployment and enqueue it durably (outbox, same transaction).
   *
   * Per-application queue policy ("latest request wins"): at most one
   * deployment runs per application at a time; any older deployment still
   * waiting in `queued` is canceled as superseded. A running deployment is
   * never interrupted by a newer request.
   */
  async create(app: Application, input: CreateDeploymentInput): Promise<Deployment> {
    if (app.deletingAt) throw notFound('Application');
    let commitSha = input.commitSha;
    if (input.rollbackOf) {
      commitSha = input.rollbackOf.commitSha ?? undefined;
    } else if (!commitSha) {
      commitSha = await this.resolveCommit(app);
    }

    const d = await this.prisma.$transaction(async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.deployment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing) return existing;
      }
      await tx.$queryRaw`SELECT id FROM "Application" WHERE id = ${app.id} FOR UPDATE`;
      const fresh = await tx.application.findUniqueOrThrow({ where: { id: app.id } });
      if (!fresh.currentConfigRevisionId || !fresh.currentEnvRevisionId) throw conflict('Application configuration is incomplete');
      const number = fresh.nextDeploymentNumber;
      await tx.application.update({ where: { id: app.id }, data: { nextDeploymentNumber: number + 1 } });

      const superseded = await tx.deployment.findMany({ where: { applicationId: app.id, status: 'queued' }, select: { id: true, number: true } });
      if (superseded.length > 0) {
        await tx.deployment.updateMany({
          where: { id: { in: superseded.map((s) => s.id) }, status: 'queued' },
          data: { status: 'canceled', failureCategory: 'superseded', errorMessage: `Superseded by deployment #${number}`, finishedAt: new Date() },
        });
        for (const s of superseded) {
          await tx.deploymentEvent.create({ data: { deploymentId: s.id, type: 'superseded', level: 'warn', message: `Canceled: superseded by deployment #${number}` } });
        }
      }

      const created = await tx.deployment.create({
        data: {
          workspaceId: app.workspaceId,
          applicationId: app.id,
          number,
          trigger: input.trigger,
          actorId: input.actorId,
          branch: input.rollbackOf ? input.rollbackOf.branch : fresh.branch,
          commitSha: commitSha ?? null,
          commitMessage: input.rollbackOf?.commitMessage ?? input.commitMessage ?? null,
          configRevisionId: input.rollbackOf ? input.rollbackOf.configRevisionId : fresh.currentConfigRevisionId,
          envRevisionId: input.rollbackOf ? input.rollbackOf.envRevisionId : fresh.currentEnvRevisionId,
          rollbackOfId: input.rollbackOf?.id ?? null,
          imageId: input.rollbackOf?.imageId ?? null,
          imageTag: input.rollbackOf?.imageTag ?? null,
          previousActiveId: fresh.activeDeploymentId,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });
      await tx.deploymentEvent.create({
        data: {
          deploymentId: created.id,
          type: 'queued',
          message: input.rollbackOf
            ? `Rollback to deployment #${input.rollbackOf.number} queued (image reused, no rebuild)`
            : `Deployment queued for commit ${commitSha?.slice(0, 12)} (${input.trigger})`,
        },
      });
      await this.outbox.add(tx, 'deployment.run', { deploymentId: created.id }, { dedupeKey: `deployment.run:${created.id}` });
      await this.audit.record(
        {
          workspaceId: app.workspaceId,
          actorId: input.actorId,
          action: input.rollbackOf ? 'deployment.rollback_requested' : 'deployment.requested',
          targetType: 'deployment',
          targetId: created.id,
          metadata: { application: app.slug, number, trigger: input.trigger, commitSha, ...(input.rollbackOf ? { rollbackOf: input.rollbackOf.number } : {}) },
          meta: input.meta,
        },
        tx,
      );
      return created;
    });
    await this.outbox.notify();
    await this.live.notifyApp(app.id);
    return d;
  }

  async rollback(app: Application, target: Deployment, actorId: string, meta: RequestMeta): Promise<Deployment> {
    if (target.applicationId !== app.id) throw notFound('Deployment');
    if (target.status !== 'succeeded' || !target.imageId) throw unprocessable('Only successfully deployed releases can be rolled back to', 'not_a_release');
    if (target.imagePrunedAt) throw unprocessable('The image for this release was removed by retention; deploy its commit again instead', 'release_unavailable');
    if (app.activeDeploymentId === target.id) throw unprocessable('This release is already active', 'already_active');
    const images = await this.runner.listImages(app.id).catch(() => null);
    if (images && !images.some((i) => i.id === target.imageId)) {
      await this.prisma.deployment.update({ where: { id: target.id }, data: { imagePrunedAt: new Date() } });
      throw unprocessable('The image for this release no longer exists on the server; deploy its commit again instead', 'release_unavailable');
    }
    return this.create(app, { trigger: 'rollback', actorId, rollbackOf: target, meta });
  }

  async cancel(deployment: Deployment, actorId: string, meta: RequestMeta): Promise<Deployment> {
    const status = deployment.status as DeploymentStatus;
    if (isTerminal(status)) throw conflict('Deployment has already finished', 'already_finished');
    if (!isCancelable(status)) throw conflict('Deployment is promoting and can no longer be canceled', 'not_cancelable');
    // Queued deployments are canceled directly; running ones are signaled and
    // the worker stops at the next safe point.
    const direct = await this.prisma.deployment.updateMany({
      where: { id: deployment.id, status: 'queued' },
      data: { status: 'canceled', cancelRequestedAt: new Date(), finishedAt: new Date(), failureCategory: null, errorMessage: 'Canceled before it started' },
    });
    if (direct.count === 0) {
      await this.prisma.deployment.updateMany({ where: { id: deployment.id, cancelRequestedAt: null }, data: { cancelRequestedAt: new Date() } });
    }
    await this.prisma.deploymentEvent.create({ data: { deploymentId: deployment.id, type: 'cancel_requested', level: 'warn', message: 'Cancellation requested' } });
    await this.audit.record({ workspaceId: deployment.workspaceId, actorId, action: 'deployment.cancel_requested', targetType: 'deployment', targetId: deployment.id, meta });
    await this.live.notifyDeployment(deployment.id);
    return this.prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
  }
}
