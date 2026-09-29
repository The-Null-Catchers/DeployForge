import { describe, expect, it } from 'vitest';
import { buildCaddyConfig, InvalidRouteError, type CaddyOptions } from './caddy-config';

const opts: CaddyOptions = { adminListen: 'unix//run/caddy-admin/admin.sock|0666', tlsMode: 'off', probeToken: 'probe-token-123456', drainSeconds: 15 };

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Caddy config builder', () => {
  it('routes each application hostname set to its upstream and ends with a 404 fallback', () => {
    const cfg = buildCaddyConfig(
      [
        { applicationId: 'a1', hostnames: ['web.apps.example.com', 'www.example.org'], upstream: { containerName: 'df-web-3-abcdef12', port: 3000 } },
        { applicationId: 'a2', hostnames: ['api.apps.example.com'], upstream: null },
      ],
      opts,
    ) as AnyObj;
    const routes = cfg.apps.http.servers.public.routes as AnyObj[];
    expect(routes[0].match[0].host).toEqual(['web.apps.example.com', 'www.example.org']);
    expect(routes[0].handle[0].upstreams[0].dial).toBe('df-web-3-abcdef12:3000');
    expect(routes[0].handle[0].stream_close_delay).toBe('15s');
    expect(routes[1].handle[0].status_code).toBe(503); // stopped app
    expect(routes[routes.length - 1].handle[0].status_code).toBe(404);
    expect(cfg.admin.listen).toBe(opts.adminListen);
  });

  it('only answers the probe listener when the secret header matches', () => {
    const cfg = buildCaddyConfig([{ applicationId: 'a1', hostnames: ['web.localhost'], upstream: { containerName: 'df-web-1-abc', port: 8080 } }], opts) as AnyObj;
    const probe = cfg.apps.http.servers.probe;
    expect(probe.listen).toEqual([':9080']);
    expect(probe.routes[0].match[0].header['X-Deployforge-Probe']).toEqual(['probe-token-123456']);
    expect(probe.routes[0].handle[0].response.set['X-Deployforge-Upstream']).toEqual(['df-web-1-abc']);
  });

  it('uses HTTP only when TLS is off and an explicit issuer otherwise (never on-demand)', () => {
    const off = buildCaddyConfig([], opts) as AnyObj;
    expect(off.apps.http.servers.public.listen).toEqual([':80']);
    expect(off.apps.http.servers.public.automatic_https.disable).toBe(true);
    const acme = buildCaddyConfig([], { ...opts, tlsMode: 'acme', acmeEmail: 'ops@example.com' }) as AnyObj;
    expect(acme.apps.http.servers.public.listen).toEqual([':443']);
    expect(acme.apps.tls.automation.policies[0].issuers[0]).toEqual({ module: 'acme', email: 'ops@example.com' });
    expect(JSON.stringify(acme)).not.toContain('on_demand');
  });

  it('rejects invalid or duplicated hostnames and unsafe upstreams before activation', () => {
    expect(() => buildCaddyConfig([{ applicationId: 'a', hostnames: ['bad host'], upstream: null }], opts)).toThrow(InvalidRouteError);
    expect(() =>
      buildCaddyConfig(
        [
          { applicationId: 'a', hostnames: ['x.example.com'], upstream: null },
          { applicationId: 'b', hostnames: ['x.example.com'], upstream: null },
        ],
        opts,
      ),
    ).toThrow(/twice/);
    expect(() => buildCaddyConfig([{ applicationId: 'a', hostnames: ['x.example.com'], upstream: { containerName: 'caddy', port: 2019 } }], opts)).toThrow(InvalidRouteError);
  });

  it('adds the dashboard route first when configured', () => {
    const cfg = buildCaddyConfig([], { ...opts, dashboard: { hostname: 'deploy.example.com', upstream: 'api:3000' } }) as AnyObj;
    expect(cfg.apps.http.servers.public.routes[0].match[0].host).toEqual(['deploy.example.com']);
  });
});
