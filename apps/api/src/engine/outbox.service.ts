import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis.service';
import type { Prisma } from '../generated/prisma/client';

export type OutboxKind =
  | 'deployment.run'
  | 'webhook.process'
  | 'app.delete'
  | 'app.lifecycle'
  | 'container.retire'
  | 'routes.sync';

export const OUTBOX_CHANNEL = 'df:outbox';

/**
 * Transactional outbox. `add` must be called with the same transaction
 * client that writes the state change, so a job exists if and only if the
 * change committed. The worker's dispatcher relays rows to BullMQ.
 */
@Injectable()
export class OutboxService {
  constructor(private readonly redis: RedisService) {}

  async add(tx: Prisma.TransactionClient, kind: OutboxKind, payload: Record<string, unknown>, opts: { dedupeKey?: string; delayMs?: number } = {}): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        kind,
        payload: payload as Prisma.InputJsonValue,
        dedupeKey: opts.dedupeKey ?? null,
        availableAt: new Date(Date.now() + (opts.delayMs ?? 0)),
      },
    });
  }

  /** Wake the dispatcher after commit (best effort; it also polls). */
  async notify(): Promise<void> {
    await this.redis.client.publish(OUTBOX_CHANNEL, '1').catch(() => undefined);
  }
}
