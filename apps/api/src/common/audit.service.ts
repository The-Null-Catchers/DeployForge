import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import type { RequestMeta } from '../auth/auth.types';
import type { Prisma } from '../generated/prisma/client';

export interface AuditInput {
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Never include secret values. Variable names are fine. */
  metadata?: Record<string, unknown>;
  meta?: RequestMeta;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;
    await db.auditEvent.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        ip: input.meta?.ip ?? null,
        userAgent: input.meta?.userAgent ?? null,
      },
    });
  }
}
