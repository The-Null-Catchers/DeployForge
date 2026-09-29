import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisService } from '../common/redis.service';

export const DEPLOY_QUEUE = 'deployforge-deployments';
export const PLATFORM_QUEUE = 'deployforge-platform';

/** BullMQ custom job IDs may not contain ':'; dedupe keys do. */
export function jobIdFor(dedupeKey: string): string {
  return dedupeKey.replace(/[^A-Za-z0-9_.-]/g, '_');
}

@Injectable()
export class QueuesService implements OnModuleDestroy {
  readonly deployments: Queue;
  readonly platform: Queue;

  constructor(redis: RedisService) {
    const connection = redis.duplicate();
    this.deployments = new Queue(DEPLOY_QUEUE, {
      connection,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 7 * 86400 } },
    });
    this.platform = new Queue(PLATFORM_QUEUE, {
      connection,
      defaultJobOptions: { attempts: 8, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 7 * 86400 } },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.deployments.close(), this.platform.close()]);
  }
}
