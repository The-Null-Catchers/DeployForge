import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * Per-application coordination lease stored in PostgreSQL (not Redis), with a
 * fencing token that increments on every acquisition.
 *
 * - Only one holder (a deployment or a lifecycle operation) can hold an
 *   application's lease at a time.
 * - A crashed holder's lease expires after its TTL and can be taken over.
 * - Promotion and other state changes are conditional on
 *   (lockDeploymentId, lockToken), so a stale worker that lost its lease can
 *   never promote, even if it keeps running.
 */
@Injectable()
export class CoordinationService {
  constructor(private readonly prisma: PrismaService) {}

  async acquire(applicationId: string, holderId: string, ttlSeconds: number): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ lockToken: number }[]>`
      UPDATE "Application"
         SET "lockDeploymentId" = ${holderId},
             "lockToken" = "lockToken" + 1,
             "lockExpiresAt" = now() + make_interval(secs => ${ttlSeconds})
       WHERE id = ${applicationId}
         AND ("lockDeploymentId" IS NULL OR "lockExpiresAt" < now())
      RETURNING "lockToken"`;
    return rows[0]?.lockToken ?? null;
  }

  async renew(applicationId: string, holderId: string, token: number, ttlSeconds: number): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "Application"
         SET "lockExpiresAt" = now() + make_interval(secs => ${ttlSeconds})
       WHERE id = ${applicationId} AND "lockDeploymentId" = ${holderId} AND "lockToken" = ${token}`;
    return n === 1;
  }

  async release(applicationId: string, holderId: string, token: number): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "Application"
         SET "lockDeploymentId" = NULL, "lockExpiresAt" = NULL
       WHERE id = ${applicationId} AND "lockDeploymentId" = ${holderId} AND "lockToken" = ${token}`;
  }

  async holder(applicationId: string): Promise<{ holderId: string | null; expired: boolean }> {
    const app = await this.prisma.application.findUnique({ where: { id: applicationId }, select: { lockDeploymentId: true, lockExpiresAt: true } });
    return { holderId: app?.lockDeploymentId ?? null, expired: !app?.lockExpiresAt || app.lockExpiresAt.getTime() < Date.now() };
  }
}
