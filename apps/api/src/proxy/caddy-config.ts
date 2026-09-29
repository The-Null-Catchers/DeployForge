import { HOSTNAME_RE } from '@deployforge/contracts';

/**
 * Pure builder for the complete Caddy JSON configuration. The whole config is
 * regenerated from authoritative database state on every change and loaded
 * atomically with POST /load, so concurrent deployments of different
 * applications can never overwrite each other's routes.
 */

export interface RouteSpec {
  applicationId: string;
  hostnames: string[];
  /** null => application stopped: serve 503. */
  upstream: { containerName: string; port: number } | null;
}

export interface CaddyOptions {
  adminListen: string;
  tlsMode: 'off' | 'internal' | 'acme';
  acmeEmail?: string;
  acmeCa?: string;
  probeToken: string;
  drainSeconds: number;
  dashboard?: { hostname: string; upstream: string };
}

const DIAL_RE = /^[a-z0-9][a-z0-9.-]{0,120}:\d{1,5}$/;
const CONTAINER_RE = /^df-[a-z0-9-]{3,100}$/;

export class InvalidRouteError extends Error {}

export function validateRoutes(routes: RouteSpec[]): void {
  const seen = new Set<string>();
  for (const r of routes) {
    for (const h of r.hostnames) {
      if (!(HOSTNAME_RE.test(h) || /^[a-z0-9-]+\.localhost$/.test(h))) throw new InvalidRouteError(`invalid hostname ${h}`);
      if (seen.has(h)) throw new InvalidRouteError(`hostname ${h} assigned twice`);
      seen.add(h);
    }
    if (r.upstream) {
      if (!CONTAINER_RE.test(r.upstream.containerName)) throw new InvalidRouteError(`invalid upstream ${r.upstream.containerName}`);
      if (!DIAL_RE.test(`${r.upstream.containerName}:${r.upstream.port}`)) throw new InvalidRouteError('invalid dial address');
    }
  }
}

function proxyHandler(dial: string, drainSeconds: number) {
  return {
    handler: 'reverse_proxy',
    upstreams: [{ dial }],
    // Keep upgraded (WebSocket) connections alive across config reloads for
    // the drain window instead of closing them on every route update.
    stream_close_delay: `${drainSeconds}s`,
  };
}

const text = (status: number, body: string) => ({
  handler: 'static_response',
  status_code: status,
  headers: { 'Content-Type': ['text/plain; charset=utf-8'], 'Cache-Control': ['no-store'] },
  body,
});

export function buildCaddyConfig(routes: RouteSpec[], opts: CaddyOptions): Record<string, unknown> {
  validateRoutes(routes);
  const publicRoutes: unknown[] = [];
  const probeRoutes: unknown[] = [];

  if (opts.dashboard) {
    publicRoutes.push({
      match: [{ host: [opts.dashboard.hostname] }],
      handle: [
        {
          handler: 'headers',
          response: {
            set: {
              'Strict-Transport-Security': opts.tlsMode === 'acme' ? ['max-age=31536000'] : undefined,
              'X-Content-Type-Options': ['nosniff'],
              'Referrer-Policy': ['same-origin'],
            },
          },
        },
        { handler: 'reverse_proxy', upstreams: [{ dial: opts.dashboard.upstream }], flush_interval: -1 },
      ],
      terminal: true,
    });
  }

  for (const r of routes) {
    if (r.hostnames.length === 0) continue;
    const dial = r.upstream ? `${r.upstream.containerName}:${r.upstream.port}` : null;
    publicRoutes.push({
      '@id': `app-${r.applicationId}`,
      match: [{ host: r.hostnames }],
      handle: [dial ? proxyHandler(dial, opts.drainSeconds) : text(503, 'This application is stopped.\n')],
      terminal: true,
    });
    if (dial) {
      probeRoutes.push({
        match: [{ host: r.hostnames, header: { 'X-Deployforge-Probe': [opts.probeToken] } }],
        handle: [
          { handler: 'headers', response: { set: { 'X-Deployforge-Upstream': [r.upstream!.containerName] }, deferred: true } },
          { handler: 'reverse_proxy', upstreams: [{ dial }] },
        ],
        terminal: true,
      });
    }
  }
  publicRoutes.push({ handle: [text(404, 'No application is deployed at this address.\n')] });
  probeRoutes.push({ handle: [text(404, 'not found\n')] });

  const tls =
    opts.tlsMode === 'acme'
      ? { automation: { policies: [{ issuers: [{ module: 'acme', email: opts.acmeEmail, ...(opts.acmeCa ? { ca: opts.acmeCa } : {}) }] }] } }
      : opts.tlsMode === 'internal'
        ? { automation: { policies: [{ issuers: [{ module: 'internal' }] }] } }
        : undefined;

  const cfg = {
    admin: { listen: opts.adminListen, config: { persist: true } },
    apps: {
      http: {
        servers: {
          public: {
            listen: opts.tlsMode === 'off' ? [':80'] : [':443'],
            routes: publicRoutes,
            ...(opts.tlsMode === 'off' ? { automatic_https: { disable: true } } : {}),
          },
          probe: {
            listen: [':9080'],
            routes: probeRoutes,
            automatic_https: { disable: true },
          },
        },
      },
      ...(tls ? { tls } : {}),
    },
  };
  return JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
}
