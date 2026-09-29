import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { RunnerClient } from '../runner/runner.client';
import { ProxyService } from '../proxy/proxy.service';
import { CoordinationService } from './coordination.service';
import { LiveService } from '../deployments/live.service';

export class RetryLater extends Error {}

@Injectable()
export class PlatformJobsService {
  private readonly logger = new Logger('PlatformJobs');

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: RunnerClient,
    private readonly proxy: ProxyService,
    private readonly coord: CoordinationService,
    private readonly live: LiveService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Retire a superseded release's container after the drain period. The
   * image is kept for rollback (subject to retention).
   */
  async retireContainer(deploymentId: string): Promise<void> {
    const d = await this.prisma.deployment.findUnique({ where: { id: deploymentId }, include: { application: true } });
    if (!d?.containerId || d.retiredAt) return;
    if (d.application.activeDeploymentId === d.id) return; // became active again; never retire the active release
    await this.runner.removeContainer(d.containerId, this.config.STOP_TIMEOUT_SECONDS);
    await this.prisma.deployment.update({ where: { id: d.id }, data: { retiredAt: new Date() } });
    await this.prisma.deploymentEvent.create({ data: { deploymentId: d.id, type: 'retired', message: 'Container stopped and removed after drain; image retained for rollback' } });
    await this.live.notifyDeployment(d.id);
  }

  /** Remove an application's routes and every Docker resource it owns, then its records. */
  async deleteApplication(applicationId: string): Promise<void> {
    const app = await this.prisma.application.findUnique({ where: { id: applicationId } });
    if (!app) return;
    const holder = `delete-${applicationId}`;
    const token = await this.coord.acquire(app.id, holder, 600);
    if (token === null) throw new RetryLater('a deployment is still running; waiting for it to stop');
    try {
      // 1. Routes first, so traffic stops before containers disappear.
      await this.proxy.sync(`delete:${app.slug}`);
      // 2. Containers, images and network labeled with this application only.
      for (const c of await this.runner.listContainers(app.id)) await this.runner.removeContainer(c.id, 5);
      for (const img of await this.runner.listImages(app.id)) {
        await this.runner.removeImage(img.id).catch((e: Error) => this.logger.warn(`image ${img.id} not removed: ${e.message}`));
      }
      await this.runner.removeNetwork(app.id).catch((e: Error) => this.logger.warn(`network not removed: ${e.message}`));
      await this.prisma.application.update({ where: { id: app.id }, data: { activeDeploymentId: null } });
      await this.prisma.application.delete({ where: { id: app.id } });
      this.logger.log(`application ${app.slug} deleted`);
    } catch (e) {
      await this.coord.release(app.id, holder, token).catch(() => undefined);
      throw e;
    }
  }
}
