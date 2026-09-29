import { Injectable, Logger } from '@nestjs/common';
import { COMMIT_SHA_RE } from '@deployforge/contracts';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { DeploymentsService } from '../deployments/deployments.service';
import { LiveService } from '../deployments/live.service';

interface PushPayload {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { id?: number; full_name?: string };
  installation?: { id?: number };
  head_commit?: { message?: string } | null;
  sender?: { login?: string };
}

/**
 * Processes stored webhook deliveries asynchronously (the HTTP handler only
 * verifies, stores and enqueues). Idempotent: deployments created from a
 * delivery use the idempotency key push:<deliveryId>:<appId>.
 */
@Injectable()
export class WebhookProcessor {
  private readonly logger = new Logger('WebhookProcessor');

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly audit: AuditService,
    private readonly live: LiveService,
  ) {}

  async process(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery || delivery.processedAt) return;
    let status = 'processed';
    let error: string | null = null;
    try {
      const payload = delivery.payload as Record<string, unknown>;
      switch (delivery.event) {
        case 'push':
          status = await this.push(deliveryId, payload as PushPayload);
          break;
        case 'installation':
          status = await this.installation(payload);
          break;
        case 'installation_repositories':
          status = await this.installationRepositories(payload);
          break;
        default:
          status = 'ignored';
      }
    } catch (e) {
      status = 'error';
      error = (e as Error).message.slice(0, 1000);
      this.logger.warn(`delivery ${deliveryId} failed: ${error}`);
    }
    await this.prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { processedAt: new Date(), status, error } });
  }

  private async push(deliveryId: string, p: PushPayload): Promise<string> {
    const ref = p.ref ?? '';
    if (!ref.startsWith('refs/heads/')) return 'ignored_non_branch';
    const branch = ref.slice('refs/heads/'.length);
    const inst = p.installation?.id ? await this.prisma.githubInstallation.findUnique({ where: { githubInstallationId: p.installation.id } }) : null;
    if (!inst || inst.status !== 'active' || !p.repository?.id) return 'ignored_unknown_installation';
    // Identity check: installation + numeric repository ID + branch must all
    // match an application's stored configuration.
    const apps = await this.prisma.application.findMany({
      where: { githubInstallationId: inst.id, githubRepositoryId: p.repository.id, branch, deletingAt: null },
    });
    if (apps.length === 0) return 'ignored_no_matching_app';

    if (p.deleted) {
      for (const app of apps) {
        await this.prisma.application.update({ where: { id: app.id }, data: { sourceStatus: 'branch_deleted' } });
        await this.audit.record({ workspaceId: app.workspaceId, action: 'github.branch_deleted', targetType: 'application', targetId: app.id, metadata: { branch, deliveryId } });
        await this.live.notifyApp(app.id);
      }
      return 'branch_deleted';
    }
    if (!p.after || !COMMIT_SHA_RE.test(p.after) || /^0+$/.test(p.after)) return 'ignored_invalid_sha';

    let deployed = 0;
    for (const app of apps) {
      if (app.sourceStatus !== 'ok') await this.prisma.application.update({ where: { id: app.id }, data: { sourceStatus: 'ok' } });
      if (!app.autoDeploy) continue;
      await this.deployments.create(app, {
        trigger: 'push',
        actorId: null,
        commitSha: p.after,
        commitMessage: p.head_commit?.message?.split('\n')[0]?.slice(0, 300),
        idempotencyKey: `push:${deliveryId}:${app.id}`,
      });
      deployed++;
    }
    return deployed > 0 ? `deployed_${deployed}` : 'autodeploy_disabled';
  }

  private async installation(payload: Record<string, unknown>): Promise<string> {
    const action = payload.action as string;
    const id = (payload.installation as { id?: number } | undefined)?.id;
    if (!id) return 'ignored';
    const inst = await this.prisma.githubInstallation.findUnique({ where: { githubInstallationId: id } });
    if (!inst) return 'ignored_unbound';
    const map: Record<string, { status: string; source: string } | undefined> = {
      deleted: { status: 'deleted', source: 'installation_disconnected' },
      suspend: { status: 'suspended', source: 'installation_disconnected' },
      unsuspend: { status: 'active', source: 'ok' },
    };
    const next = map[action];
    if (!next) return 'ignored';
    await this.prisma.githubInstallation.update({ where: { id: inst.id }, data: { status: next.status } });
    await this.prisma.application.updateMany({ where: { githubInstallationId: inst.id }, data: { sourceStatus: next.source } });
    await this.audit.record({ workspaceId: inst.workspaceId, action: `github.installation_${action}`, targetType: 'github_installation', targetId: inst.id });
    return `installation_${action}`;
  }

  private async installationRepositories(payload: Record<string, unknown>): Promise<string> {
    const id = (payload.installation as { id?: number } | undefined)?.id;
    const inst = id ? await this.prisma.githubInstallation.findUnique({ where: { githubInstallationId: id } }) : null;
    if (!inst) return 'ignored_unbound';
    const removed = ((payload.repositories_removed as { id: number }[] | undefined) ?? []).map((r) => r.id);
    const added = ((payload.repositories_added as { id: number }[] | undefined) ?? []).map((r) => r.id);
    if (removed.length) {
      await this.prisma.application.updateMany({ where: { githubInstallationId: inst.id, githubRepositoryId: { in: removed } }, data: { sourceStatus: 'access_removed' } });
    }
    if (added.length) {
      await this.prisma.application.updateMany({ where: { githubInstallationId: inst.id, githubRepositoryId: { in: added }, sourceStatus: 'access_removed' }, data: { sourceStatus: 'ok' } });
    }
    await this.audit.record({ workspaceId: inst.workspaceId, action: 'github.repositories_changed', targetType: 'github_installation', targetId: inst.id, metadata: { added, removed } });
    return 'repositories_changed';
  }
}
