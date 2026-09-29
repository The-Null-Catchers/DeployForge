import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { DiagnosticsView } from '@deployforge/contracts';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { forbidden } from '../common/errors';
import { Auth, Public, type AuthContext } from '../auth/auth.types';
import { RunnerClient } from '../runner/runner.client';
import { QueuesService } from '../engine/queues';

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; latencyMs: number; value: T } | { ok: false; error: string }> {
  const t = Date.now();
  try {
    const value = await fn();
    return { ok: true, latencyMs: Date.now() - t, value };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

@ApiTags('platform')
@Controller()
export class DiagnosticsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly runner: RunnerClient,
    private readonly queues: QueuesService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: the process is up. No dependencies checked. */
  @Public()
  @Get('healthz')
  @HttpCode(200)
  @ApiOperation({ summary: 'Liveness probe' })
  live() {
    return { status: 'ok' };
  }

  /** Readiness: database and Redis reachable. */
  @Public()
  @Get('readyz')
  @ApiOperation({ summary: 'Readiness probe (database and Redis)' })
  async ready(@Res() res: Response): Promise<void> {
    const [db, redis] = await Promise.all([timed(() => this.prisma.$queryRaw`SELECT 1`), timed(() => this.redis.client.ping())]);
    const ok = db.ok && redis.ok;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', database: db.ok, redis: redis.ok });
  }

  @Get('api/diagnostics')
  @ApiOperation({ summary: 'Platform diagnostics (instance admins and workspace owners)' })
  async diagnostics(@Auth() auth: AuthContext): Promise<DiagnosticsView> {
    if (!auth.isInstanceAdmin) {
      const owner = await this.prisma.membership.findFirst({ where: { userId: auth.userId, role: 'owner' } });
      if (!owner) throw forbidden('Platform diagnostics are available to workspace owners');
    }
    const [db, redis, runner, counts, outbox, proxy, reconciler, images] = await Promise.all([
      timed(() => this.prisma.$queryRaw`SELECT 1`),
      timed(() => this.redis.client.ping()),
      timed(() => this.runner.health()),
      timed(async () => {
        const [a, b] = await Promise.all([
          this.queues.deployments.getJobCounts('waiting', 'active', 'delayed', 'failed'),
          this.queues.platform.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        ]);
        return { waiting: (a.waiting ?? 0) + (b.waiting ?? 0), active: (a.active ?? 0) + (b.active ?? 0), delayed: (a.delayed ?? 0) + (b.delayed ?? 0), failed: (a.failed ?? 0) + (b.failed ?? 0) };
      }),
      timed(() => this.prisma.outboxEvent.count({ where: { dispatchedAt: null } })),
      this.prisma.platformState.findUnique({ where: { key: 'proxy' } }),
      this.prisma.platformState.findUnique({ where: { key: 'reconciler' } }),
      timed(() => this.runner.listImages()),
    ]);
    const p = (proxy?.value ?? {}) as { ok?: boolean; lastSyncAt?: string; lastError?: string | null; routeCount?: number };
    const r = (reconciler?.value ?? {}) as { lastRunAt?: string; ok?: boolean; result?: Record<string, unknown> };
    return {
      checkedAt: new Date().toISOString(),
      database: db.ok ? { ok: true, latencyMs: db.latencyMs } : { ok: false, error: db.error },
      redis: redis.ok ? { ok: true, latencyMs: redis.latencyMs } : { ok: false, error: redis.error },
      queue: {
        ok: counts.ok,
        ...(counts.ok ? counts.value : { waiting: 0, active: 0, delayed: 0, failed: 0 }),
        outboxPending: outbox.ok ? outbox.value : -1,
      },
      runner: runner.ok
        ? { ok: runner.value.ok, version: runner.value.runnerVersion, docker: runner.value.docker.version ?? runner.value.docker.error, buildx: runner.value.buildx.version ?? runner.value.buildx.error, activeBuilds: runner.value.activeBuilds, maxConcurrentBuilds: runner.value.maxConcurrentBuilds }
        : { ok: false, error: runner.error },
      proxy: { ok: p.ok ?? false, lastSyncAt: p.lastSyncAt ?? null, lastError: p.lastError ?? null, routeCount: p.routeCount ?? 0 },
      reconciler: { lastRunAt: r.lastRunAt ?? null, lastResult: r.result ? JSON.stringify(r.result) : null },
      disk: images.ok ? { imageCount: images.value.length, imageBytes: images.value.reduce((s, i) => s + i.sizeBytes, 0) } : null,
    };
  }
}
