import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { CONFIG, type AppConfig } from '../config/config';

/**
 * Redis connections. Redis is used for BullMQ, rate limiting and live-update
 * notifications. It is never the source of truth for deployment state.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  private readonly subscribers: Redis[] = [];

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.client = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  }

  /** A dedicated connection for BullMQ or pub/sub. */
  duplicate(): Redis {
    const c = new IORedis(this.config.REDIS_URL, { maxRetriesPerRequest: null });
    this.subscribers.push(c);
    return c;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.client.quit(), ...this.subscribers.map((s) => s.quit())]);
  }
}
