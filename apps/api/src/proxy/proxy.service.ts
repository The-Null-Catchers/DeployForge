import { Inject, Injectable, Logger } from '@nestjs/common';
import http from 'node:http';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { buildCaddyConfig, type RouteSpec } from './caddy-config';

export interface RouteOverride {
  applicationId: string;
  containerName: string;
  port: number;
}

export class ProxyError extends Error {}

const ROUTES_LOCK = 7_302_025;

/**
 * Owns the reverse proxy configuration. All updates:
 *  1. take a PostgreSQL advisory lock (serialization across processes),
 *  2. rebuild the full config from the database (+ an optional candidate
 *     override during promotion),
 *  3. POST it to Caddy's /load, which validates and swaps atomically and
 *     keeps the previous config if the new one fails to load.
 */
@Injectable()
export class ProxyService {
  private readonly logger = new Logger('ProxyService');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async desiredRoutes(db: Prisma.TransactionClient, override?: RouteOverride): Promise<RouteSpec[]> {
    const apps = await db.application.findMany({
      where: { deletingAt: null },
      include: { activeDeployment: true, domains: true },
      orderBy: { createdAt: 'asc' },
    });
    const routes: RouteSpec[] = [];
    for (const app of apps) {
      const isOverride = override?.applicationId === app.id;
      const active = app.activeDeployment;
      if (!isOverride && !active?.containerName) continue;
      const hostnames = app.domains
        .filter((d) => d.kind === 'platform' || d.status === 'verified' || d.status === 'active')
        .map((d) => d.hostname)
        .sort();
      const cfg = active && !isOverride ? await db.configRevision.findUnique({ where: { id: active.configRevisionId } }) : null;
      const port = isOverride ? override.port : ((cfg?.config as { port?: number } | null)?.port ?? app.port);
      const upstream = isOverride
        ? { containerName: override.containerName, port }
        : app.desiredState === 'stopped'
          ? null
          : { containerName: active!.containerName!, port };
      routes.push({ applicationId: app.id, hostnames, upstream });
    }
    return routes;
  }

  private build(routes: RouteSpec[]) {
    return buildCaddyConfig(routes, {
      adminListen: this.config.CADDY_ADMIN_LISTEN,
      tlsMode: this.config.TLS_MODE,
      acmeEmail: this.config.ACME_EMAIL,
      acmeCa: this.config.ACME_CA,
      probeToken: this.config.PROXY_PROBE_TOKEN,
      drainSeconds: Math.max(this.config.DRAIN_SECONDS, 5),
      dashboard:
        this.config.DASHBOARD_HOSTNAME && this.config.DASHBOARD_UPSTREAM
          ? { hostname: this.config.DASHBOARD_HOSTNAME, upstream: this.config.DASHBOARD_UPSTREAM }
          : undefined,
    });
  }

  /** Reconcile Caddy with the database. Safe to call at any time. */
  async sync(reason: string): Promise<number> {
    try {
      const count = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROUTES_LOCK})`;
          const routes = await this.desiredRoutes(tx);
          await this.load(this.build(routes));
          return routes.length;
        },
        { timeout: 30_000, maxWait: 30_000 },
      );
      await this.recordStatus(true, null, count);
      this.logger.log(`routes synced (${reason}): ${count} applications`);
      return count;
    } catch (e) {
      await this.recordStatus(false, (e as Error).message, null);
      throw e;
    }
  }

  /**
   * Point an application's hostnames at a healthy candidate, verify through
   * the proxy that traffic reaches it, then run `commit` (the fenced DB
   * promotion) inside the same serialized section. On any failure the
   * caller must call `sync()` to restore the previous route.
   */
  async promote<T>(
    override: RouteOverride,
    verifyPath: string,
    precheck: (tx: Prisma.TransactionClient) => Promise<void>,
    commit: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROUTES_LOCK})`;
        // Checked before Caddy is touched so a stale worker never routes traffic.
        await precheck(tx);
        const routes = await this.desiredRoutes(tx, override);
        const config = this.build(routes);
        await this.load(config);
        const route = routes.find((r) => r.applicationId === override.applicationId);
        const hostname = route?.hostnames[0];
        if (!hostname) throw new ProxyError('application has no hostname to route');
        await this.verifyRoute(hostname, verifyPath, override.containerName);
        const result = await commit(tx);
        await this.recordStatus(true, null, routes.length, tx);
        return result;
      },
      { timeout: 45_000, maxWait: 60_000 },
    );
  }

  /** Request through Caddy's token-gated probe listener and check which upstream answered. */
  async verifyRoute(hostname: string, path: string, expectedContainer: string): Promise<void> {
    let lastError = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const res = await this.probeRequest(hostname, path);
        if (res.upstream === expectedContainer) return;
        lastError = res.upstream ? `routed to ${res.upstream}, expected ${expectedContainer}` : `probe returned ${res.status} without upstream header`;
      } catch (e) {
        lastError = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new ProxyError(`route verification failed: ${lastError}`);
  }

  private probeRequest(hostname: string, path: string): Promise<{ status: number; upstream: string | null }> {
    const url = new URL(path, this.config.CADDY_PROBE_URL);
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: 'GET', timeout: 5000, headers: { host: hostname, 'x-deployforge-probe': this.config.PROXY_PROBE_TOKEN } },
        (res) => {
          res.resume();
          const up = res.headers['x-deployforge-upstream'];
          resolve({ status: res.statusCode ?? 0, upstream: typeof up === 'string' ? up : null });
        },
      );
      req.on('timeout', () => req.destroy(new Error('probe timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  /** POST /load to the Caddy admin API (unix socket or private address). */
  async load(config: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(config);
    const target = this.config.CADDY_ADMIN_URL;
    const opts: http.RequestOptions = { method: 'POST', path: '/load', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 20_000 };
    if (target.startsWith('unix://')) {
      opts.socketPath = target.slice('unix://'.length);
      opts.headers = { ...opts.headers, host: 'caddy-admin' };
    } else {
      const u = new URL(target);
      opts.hostname = u.hostname;
      opts.port = u.port;
    }
    await new Promise<void>((resolve, reject) => {
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c.toString()));
        res.on('end', () => {
          if ((res.statusCode ?? 500) < 300) resolve();
          else reject(new ProxyError(`Caddy rejected the configuration (${res.statusCode}): ${data.slice(0, 500)}`));
        });
      });
      req.on('timeout', () => req.destroy(new ProxyError('Caddy admin API timed out')));
      req.on('error', (e) => reject(new ProxyError(`Caddy admin API unreachable: ${e.message}`)));
      req.end(body);
    });
  }

  private async recordStatus(ok: boolean, error: string | null, routeCount: number | null, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;
    const prev = await db.platformState.findUnique({ where: { key: 'proxy' } });
    const prevValue = (prev?.value ?? {}) as Record<string, unknown>;
    const value = {
      ...prevValue,
      ok,
      lastError: error,
      ...(ok ? { lastSyncAt: new Date().toISOString(), routeCount } : { lastFailureAt: new Date().toISOString() }),
    } as Prisma.InputJsonValue;
    await db.platformState.upsert({ where: { key: 'proxy' }, create: { key: 'proxy', value }, update: { value } });
  }
}
