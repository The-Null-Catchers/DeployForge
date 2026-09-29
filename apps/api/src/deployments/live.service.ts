import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { RedisService } from '../common/redis.service';

const PREFIX = 'df:live:';

/**
 * Cross-process change notifications for SSE. Notifications carry no data:
 * listeners re-read authoritative state from PostgreSQL, so a lost
 * notification only delays an update until the next poll.
 */
@Injectable()
export class LiveService implements OnModuleDestroy {
  private readonly logger = new Logger('LiveService');
  private readonly emitter = new EventEmitter();
  private sub: Redis | null = null;

  constructor(private readonly redis: RedisService) {
    this.emitter.setMaxListeners(0);
  }

  private ensureSubscriber(): void {
    if (this.sub) return;
    this.sub = this.redis.duplicate();
    this.sub.psubscribe(`${PREFIX}*`).catch((e: Error) => this.logger.error(`subscribe failed: ${e.message}`));
    this.sub.on('pmessage', (_p: string, channel: string) => this.emitter.emit(channel.slice(PREFIX.length)));
  }

  on(topic: string, fn: () => void): () => void {
    this.ensureSubscriber();
    this.emitter.on(topic, fn);
    return () => this.emitter.off(topic, fn);
  }

  async notifyDeployment(id: string): Promise<void> {
    await this.redis.client.publish(`${PREFIX}deployment:${id}`, '1').catch(() => undefined);
  }

  async notifyApp(id: string): Promise<void> {
    await this.redis.client.publish(`${PREFIX}app:${id}`, '1').catch(() => undefined);
  }

  onModuleDestroy(): void {
    this.sub?.disconnect();
  }
}
