import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DelayedError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { DeploymentExecutor } from './deployment.executor';
import { PlatformJobsService, RetryLater } from './platform-jobs.service';
import { ReconcilerService } from './reconciler.service';
import { QueuesService, DEPLOY_QUEUE, PLATFORM_QUEUE, jobIdFor } from './queues';
import { OUTBOX_CHANNEL } from './outbox.service';
import { ProxyService } from '../proxy/proxy.service';
import { WebhookProcessor } from '../github/webhook.processor';

/**
 * The worker process: relays the outbox to BullMQ, executes deployments and
 * platform jobs, and runs the reconciler. Enabled when
 * DEPLOYFORGE_PROCESS is `worker` or `all`.
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Worker');
  private workers: Worker[] = [];
  private timers: NodeJS.Timeout[] = [];
  private sub: Redis | null = null;
  private dispatching = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueuesService,
    private readonly executor: DeploymentExecutor,
    private readonly jobs: PlatformJobsService,
    private readonly reconciler: ReconcilerService,
    private readonly proxy: ProxyService,
    private readonly webhooks: WebhookProcessor,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.DEPLOYFORGE_PROCESS === 'api') return;
    const connection = this.redis.duplicate();
    const deployWorker = new Worker(
      DEPLOY_QUEUE,
      async (job: Job, token?: string) => {
        const result = await this.executor.run(job.data.deploymentId as string);
        if (result === 'busy') {
          // Another deployment/operation holds this application's lease:
          // wait without consuming an attempt.
          await job.moveToDelayed(Date.now() + 3000, token);
          throw new DelayedError();
        }
      },
      { connection, concurrency: this.config.DEPLOY_WORKER_CONCURRENCY, lockDuration: 60_000, stalledInterval: 30_000, maxStalledCount: 2 },
    );
    const platformWorker = new Worker(
      PLATFORM_QUEUE,
      async (job: Job, token?: string) => {
        try {
          switch (job.name) {
            case 'container.retire':
              return await this.jobs.retireContainer(job.data.deploymentId as string);
            case 'app.delete':
              return await this.jobs.deleteApplication(job.data.applicationId as string);
            case 'routes.sync':
              return await this.proxy.sync(String(job.data.reason ?? 'job'));
            case 'webhook.process':
              return await this.webhooks.process(job.data.deliveryId as string);
            default:
              this.logger.warn(`unknown platform job ${job.name}`);
          }
        } catch (e) {
          if (e instanceof RetryLater) {
            await job.moveToDelayed(Date.now() + 5000, token);
            throw new DelayedError();
          }
          throw e;
        }
      },
      { connection: this.redis.duplicate(), concurrency: 4 },
    );
    for (const w of [deployWorker, platformWorker]) {
      w.on('failed', (job, err) => this.logger.warn(`job ${job?.name} ${job?.id} failed: ${err.message}`));
      w.on('error', (err) => this.logger.error(`worker error: ${err.message}`));
    }
    this.workers = [deployWorker, platformWorker];

    // Outbox dispatcher: poll + wake on notify.
    this.sub = this.redis.duplicate();
    await this.sub.subscribe(OUTBOX_CHANNEL);
    this.sub.on('message', () => void this.dispatch());
    this.timers.push(setInterval(() => void this.dispatch(), 1000));

    // Reconciler: shortly after startup, then periodically.
    this.timers.push(setTimeout(() => void this.reconciler.runOnce(), 3000));
    this.timers.push(setInterval(() => void this.reconciler.runOnce(), this.config.RECONCILE_INTERVAL_SECONDS * 1000));
    this.logger.log(`worker started (deploy concurrency ${this.config.DEPLOY_WORKER_CONCURRENCY})`);
  }

  /** Relay committed outbox rows to BullMQ. jobId = dedupe key, so replays are harmless. */
  async dispatch(): Promise<number> {
    if (this.dispatching || this.stopped) return 0;
    this.dispatching = true;
    let total = 0;
    try {
      for (;;) {
        const n = await this.prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ id: bigint; kind: string; payload: Record<string, unknown>; dedupeKey: string | null }[]>`
            SELECT id, kind, payload, "dedupeKey" FROM "OutboxEvent"
             WHERE "dispatchedAt" IS NULL AND "availableAt" <= now()
             ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED`;
          for (const r of rows) {
            const queue = r.kind === 'deployment.run' ? this.queues.deployments : this.queues.platform;
            try {
              await queue.add(r.kind, r.payload, { jobId: jobIdFor(r.dedupeKey ?? `outbox:${r.id}`) });
              await tx.outboxEvent.update({ where: { id: r.id }, data: { dispatchedAt: new Date(), attempts: { increment: 1 } } });
            } catch (e) {
              await tx.outboxEvent.update({ where: { id: r.id }, data: { attempts: { increment: 1 }, lastError: (e as Error).message.slice(0, 500), availableAt: new Date(Date.now() + 5000) } });
            }
          }
          return rows.length;
        });
        total += n;
        if (n < 50) break;
      }
    } catch (e) {
      this.logger.warn(`outbox dispatch failed: ${(e as Error).message}`);
    } finally {
      this.dispatching = false;
    }
    return total;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.sub?.disconnect();
    await Promise.allSettled(this.workers.map((w) => w.close()));
  }
}
