import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Resolver } from 'node:dns/promises';
import type { z } from 'zod';
import { createDomainRequestSchema, type DomainView } from '@deployforge/contracts';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { conflict } from '../common/errors';
import { jsonSchema } from '../common/openapi';
import { randomToken } from '../crypto/tokens';
import { Auth, Meta, type AuthContext, type RequestMeta } from '../auth/auth.types';
import { OutboxService } from '../engine/outbox.service';
import { platformHostname } from '../deployments/views';
import type { Domain, Prisma } from '../generated/prisma/client';

export const CHALLENGE_PREFIX = '_deployforge-challenge';

/**
 * Custom domains. A domain is routed (and therefore gets a certificate) only
 * after its owner proves control with a DNS TXT record, which prevents
 * claiming someone else's hostname. Certificates are requested only for
 * hostnames present in the proxy config: there is no on-demand issuance.
 */
@ApiTags('domains')
@Controller('api')
export class DomainsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private view(d: Domain, slug: string, hasActive: boolean): DomainView {
    const observed = (d.dnsObserved as string[] | null) ?? [];
    const routed = d.kind === 'platform' || d.status === 'verified' || d.status === 'active';
    return {
      id: d.id,
      hostname: d.hostname,
      kind: d.kind,
      status: d.kind === 'custom' && d.status === 'verified' && hasActive ? 'active' : d.status,
      verification: d.kind === 'custom' && d.verificationToken ? { recordName: `${CHALLENGE_PREFIX}.${d.hostname}`, recordType: 'TXT', recordValue: d.verificationToken } : null,
      dns: { expectedTarget: this.config.PUBLIC_IPV4 ?? platformHostname(this.config, slug), observed, ok: d.dnsOk, checkedAt: d.dnsCheckedAt?.toISOString() ?? null },
      routing: routed && hasActive ? 'active' : 'inactive',
      tls: this.config.TLS_MODE === 'acme' ? 'automatic' : this.config.TLS_MODE === 'internal' ? 'internal' : 'disabled',
      lastError: d.lastError,
      createdAt: d.createdAt.toISOString(),
    };
  }

  @Get('apps/:id/domains')
  @ApiOperation({ summary: 'Platform and custom domains of an application' })
  async list(@Auth() auth: AuthContext, @Param('id') id: string): Promise<DomainView[]> {
    const { app } = await this.access.app(auth, id, 'domain.read');
    const rows = await this.prisma.domain.findMany({ where: { applicationId: app.id }, orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }] });
    return rows.map((d) => this.view(d, app.slug, !!app.activeDeploymentId));
  }

  @Post('apps/:id/domains')
  @ApiOperation({ summary: 'Add a custom domain (pending until DNS TXT verification succeeds)' })
  @ApiBody({ schema: jsonSchema(createDomainRequestSchema) })
  async add(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodPipe(createDomainRequestSchema)) body: z.infer<typeof createDomainRequestSchema>, @Meta() meta: RequestMeta): Promise<DomainView> {
    const { app } = await this.access.app(auth, id, 'domain.write');
    const host = body.hostname;
    const base = this.config.APPS_DOMAIN.toLowerCase();
    if (host === base || host.endsWith(`.${base}`)) throw conflict(`Hostnames under ${base} are reserved for platform subdomains`, 'reserved_domain');
    if (this.config.DASHBOARD_HOSTNAME && host === this.config.DASHBOARD_HOSTNAME.toLowerCase()) throw conflict('That hostname is used by the DeployForge dashboard', 'reserved_domain');
    const count = await this.prisma.domain.count({ where: { applicationId: app.id, kind: 'custom' } });
    if (count >= 20) throw conflict('At most 20 custom domains per application', 'too_many_domains');
    const existing = await this.prisma.domain.findUnique({ where: { hostname: host } });
    if (existing) throw conflict('That domain is already assigned to an application', 'domain_taken');
    const d = await this.prisma.domain.create({
      data: { workspaceId: app.workspaceId, applicationId: app.id, hostname: host, kind: 'custom', status: 'pending_verification', verificationToken: `df-verify-${randomToken('', 18)}` },
    });
    await this.audit.record({ workspaceId: app.workspaceId, actorId: auth.userId, action: 'domain.added', targetType: 'domain', targetId: d.id, metadata: { hostname: host }, meta });
    return this.view(d, app.slug, !!app.activeDeploymentId);
  }

  private resolver(): Resolver {
    const r = new Resolver({ timeout: 4000, tries: 2 });
    if (this.config.DNS_SERVERS.length) r.setServers(this.config.DNS_SERVERS);
    return r;
  }

  @Post('domains/:id/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check the TXT ownership record and DNS target; activates routing when verified' })
  async verify(@Auth() auth: AuthContext, @Param('id') id: string, @Meta() meta: RequestMeta): Promise<DomainView> {
    const { domain, app } = await this.access.domain(auth, id, 'domain.write');
    if (domain.kind !== 'custom') return this.view(domain, app.slug, !!app.activeDeploymentId);
    const resolver = this.resolver();
    let verified = domain.status === 'verified' || domain.status === 'active';
    let lastError: string | null = null;
    if (!verified) {
      try {
        const records = (await resolver.resolveTxt(`${CHALLENGE_PREFIX}.${domain.hostname}`)).map((parts) => parts.join(''));
        verified = records.includes(domain.verificationToken ?? '');
        if (!verified) lastError = `TXT record ${CHALLENGE_PREFIX}.${domain.hostname} does not contain the expected value yet`;
      } catch (e) {
        lastError = `TXT lookup failed: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`;
      }
    }
    // Informational: where does the hostname currently point?
    const observed: string[] = [];
    let dnsOk: boolean | null = null;
    try {
      observed.push(...(await resolver.resolve4(domain.hostname)));
    } catch {
      /* no A records */
    }
    try {
      observed.push(...(await resolver.resolveCname(domain.hostname)).map((c) => `CNAME ${c}`));
    } catch {
      /* no CNAME */
    }
    if (this.config.PUBLIC_IPV4) dnsOk = observed.includes(this.config.PUBLIC_IPV4) || observed.includes(`CNAME ${platformHostname(this.config, app.slug)}`);
    else dnsOk = observed.includes(`CNAME ${platformHostname(this.config, app.slug)}`) || (observed.length > 0 ? null : false);

    const updated = await this.prisma.domain.update({
      where: { id: domain.id },
      data: {
        status: verified ? 'verified' : domain.status === 'error' ? 'error' : 'pending_verification',
        verifiedAt: verified && !domain.verifiedAt ? new Date() : domain.verifiedAt,
        lastError: verified ? null : lastError,
        dnsObserved: observed as unknown as Prisma.InputJsonValue,
        dnsOk,
        dnsCheckedAt: new Date(),
      },
    });
    if (verified && !domain.verifiedAt) {
      await this.audit.record({ workspaceId: app.workspaceId, actorId: auth.userId, action: 'domain.verified', targetType: 'domain', targetId: domain.id, metadata: { hostname: domain.hostname }, meta });
      await this.prisma.$transaction(async (tx) => this.outbox.add(tx, 'routes.sync', { reason: `domain-verified:${domain.hostname}` }));
      await this.outbox.notify();
    }
    return this.view(updated, app.slug, !!app.activeDeploymentId);
  }

  @Delete('domains/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a custom domain (routes are removed before the record)' })
  async remove(@Auth() auth: AuthContext, @Param('id') id: string, @Meta() meta: RequestMeta): Promise<void> {
    const { domain, app } = await this.access.domain(auth, id, 'domain.write');
    if (domain.kind === 'platform') throw conflict('The platform domain cannot be removed', 'platform_domain');
    await this.prisma.$transaction(async (tx) => {
      await tx.domain.delete({ where: { id: domain.id } });
      await this.outbox.add(tx, 'routes.sync', { reason: `domain-removed:${domain.hostname}` });
      await this.audit.record({ workspaceId: app.workspaceId, actorId: auth.userId, action: 'domain.removed', targetType: 'domain', targetId: domain.id, metadata: { hostname: domain.hostname }, meta }, tx);
    });
    await this.outbox.notify();
  }
}
