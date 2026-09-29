import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  acceptInviteRequestSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  permissionsFor,
  refreshRequestSchema,
  setupRequestSchema,
  tokenLoginRequestSchema,
  type Role,
  type SessionInfo,
  type SessionView,
  type TokenPair,
} from '@deployforge/contracts';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { ZodPipe } from '../common/zod.pipe';
import { RateLimitService } from '../common/rate-limit.service';
import { AuditService } from '../common/audit.service';
import { conflict, forbidden, notFound } from '../common/errors';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../crypto/passwords';
import { safeEqual, sha256Hex } from '../crypto/tokens';
import { Auth, Meta, Public, SESSION_COOKIE, type AuthContext, type RequestMeta, type RequestWithAuth } from './auth.types';
import { SessionService } from './session.service';
import { AuthGuard } from './auth.guard';
import { jsonSchema } from '../common/openapi';

const setupWithTokenSchema = setupRequestSchema.extend({ setupToken: z.string().max(200).optional() });

@ApiTags('auth')
@Controller('api')
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly guard: AuthGuard,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('auth/status')
  @ApiOperation({ summary: 'Instance status: whether first-run setup is required' })
  async status() {
    const users = await this.prisma.user.count();
    return {
      setupRequired: users === 0,
      setupTokenRequired: this.config.isProduction || !!this.config.SETUP_TOKEN,
      githubEnabled: this.config.GITHUB_MODE !== 'disabled',
      appsDomain: this.config.APPS_DOMAIN,
      tlsMode: this.config.TLS_MODE,
      // Test-only extra git hosts (empty in production; refused by config validation there).
      gitExtraAllowedHosts: this.config.GIT_EXTRA_ALLOWED_HOSTS,
      version: '0.1.0',
    };
  }

  @Public()
  @Post('setup')
  @ApiOperation({ summary: 'First-run setup: create the instance owner and first workspace' })
  @ApiBody({ schema: jsonSchema(setupWithTokenSchema) })
  async setup(@Body(new ZodPipe(setupWithTokenSchema)) body: z.infer<typeof setupWithTokenSchema>, @Meta() meta: RequestMeta, @Req() req: RequestWithAuth, @Res({ passthrough: true }) res: Response): Promise<SessionInfo> {
    this.guard.checkOrigin(req);
    await this.rateLimit.enforce(`setup:${meta.ip}`, 10, 900);
    if (this.config.isProduction && !this.config.SETUP_TOKEN) {
      throw forbidden('SETUP_TOKEN is not configured. Run scripts/setup.mjs to generate one.');
    }
    if (this.config.SETUP_TOKEN && (!body.setupToken || !safeEqual(sha256Hex(body.setupToken), sha256Hex(this.config.SETUP_TOKEN)))) {
      throw forbidden('Invalid setup token. It is printed by the setup script and stored in the server environment.');
    }
    const passwordHash = await hashPassword(body.password);
    const user = await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent setup attempts.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(424242)`;
      if ((await tx.user.count()) > 0) throw conflict('Setup has already been completed', 'setup_complete');
      const u = await tx.user.create({ data: { email: body.email, name: body.name, passwordHash, isInstanceAdmin: true } });
      const ws = await tx.workspace.create({ data: { name: body.workspaceName, slug: await uniqueSlug(tx, body.workspaceName) } });
      await tx.membership.create({ data: { workspaceId: ws.id, userId: u.id, role: 'owner' } });
      await tx.project.create({ data: { workspaceId: ws.id, name: 'Default', description: 'Created during setup' } });
      await this.audit.record({ workspaceId: ws.id, actorId: u.id, action: 'instance.setup', targetType: 'user', targetId: u.id, meta }, tx);
      return u;
    });
    return this.startBrowserSession(user.id, meta, res);
  }

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Browser login (sets an HttpOnly session cookie)' })
  @ApiBody({ schema: jsonSchema(loginRequestSchema) })
  async login(@Body(new ZodPipe(loginRequestSchema)) body: z.infer<typeof loginRequestSchema>, @Meta() meta: RequestMeta, @Req() req: RequestWithAuth, @Res({ passthrough: true }) res: Response): Promise<SessionInfo> {
    this.guard.checkOrigin(req);
    const user = await this.verifyCredentials(body.email, body.password, meta);
    await this.audit.record({ actorId: user.id, action: 'auth.login', targetType: 'session', metadata: { kind: 'browser' }, meta });
    return this.startBrowserSession(user.id, meta, res);
  }

  @Public()
  @Post('auth/token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Native client login: returns a short-lived access token and a rotating refresh token' })
  @ApiBody({ schema: jsonSchema(tokenLoginRequestSchema) })
  async tokenLogin(@Body(new ZodPipe(tokenLoginRequestSchema)) body: z.infer<typeof tokenLoginRequestSchema>, @Meta() meta: RequestMeta): Promise<TokenPair> {
    const user = await this.verifyCredentials(body.email, body.password, meta);
    const pair = await this.sessions.createMobileSession(user.id, body.deviceName, meta);
    await this.audit.record({ actorId: user.id, action: 'auth.login', targetType: 'session', targetId: pair.sessionId, metadata: { kind: 'mobile', device: body.deviceName }, meta });
    return pair;
  }

  @Public()
  @Post('auth/token/refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate a refresh token (single use; reuse revokes the session)' })
  @ApiBody({ schema: jsonSchema(refreshRequestSchema) })
  async refresh(@Body(new ZodPipe(refreshRequestSchema)) body: z.infer<typeof refreshRequestSchema>, @Meta() meta: RequestMeta): Promise<TokenPair> {
    await this.rateLimit.enforce(`refresh:${meta.ip}`, 120, 60);
    return this.sessions.refresh(body.refreshToken);
  }

  @Post('auth/logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Log out and revoke the current session (browser or native)' })
  async logout(@Auth() auth: AuthContext, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.sessions.revoke(auth.sessionId, 'logout');
    await this.audit.record({ actorId: auth.userId, action: 'auth.logout', targetType: 'session', targetId: auth.sessionId, meta });
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('auth/me')
  @ApiOperation({ summary: 'Current user, workspaces with roles and permissions, CSRF token' })
  async me(@Auth() auth: AuthContext): Promise<SessionInfo> {
    let csrfToken: string | undefined;
    if (auth.via === 'cookie') {
      const s = await this.prisma.session.findUnique({ where: { id: auth.sessionId } });
      csrfToken = s?.csrfSecret ?? undefined;
    }
    return this.sessionInfo(auth.userId, auth.sessionId, csrfToken);
  }

  @Get('auth/sessions')
  @ApiOperation({ summary: 'List your active sessions' })
  async listSessions(@Auth() auth: AuthContext): Promise<SessionView[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId: auth.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      kind: s.kind,
      deviceName: s.deviceName,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === auth.sessionId,
    }));
  }

  @Delete('auth/sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke one of your sessions' })
  async revokeSession(@Auth() auth: AuthContext, @Param('id') id: string, @Meta() meta: RequestMeta): Promise<void> {
    const s = await this.prisma.session.findUnique({ where: { id } });
    if (!s || s.userId !== auth.userId) throw notFound('Session');
    await this.sessions.revoke(id, 'revoked_by_user');
    await this.audit.record({ actorId: auth.userId, action: 'auth.session_revoked', targetType: 'session', targetId: id, meta });
  }

  @Post('auth/password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Change password; revokes all other sessions' })
  @ApiBody({ schema: jsonSchema(changePasswordRequestSchema) })
  async changePassword(@Auth() auth: AuthContext, @Body(new ZodPipe(changePasswordRequestSchema)) body: z.infer<typeof changePasswordRequestSchema>, @Meta() meta: RequestMeta): Promise<void> {
    await this.rateLimit.enforce(`pw:${auth.userId}`, 10, 900);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) throw forbidden('Current password is incorrect');
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
    const n = await this.sessions.revokeAllForUser(user.id, 'password_changed', auth.sessionId);
    await this.audit.record({ actorId: user.id, action: 'auth.password_changed', targetType: 'user', targetId: user.id, metadata: { revokedSessions: n }, meta });
  }

  @Public()
  @Get('invites/:token')
  @ApiOperation({ summary: 'Look up an invitation before accepting it' })
  async inviteInfo(@Param('token') token: string, @Meta() meta: RequestMeta) {
    await this.rateLimit.enforce(`invite:${meta.ip}`, 30, 900);
    const inv = await this.prisma.invite.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { workspace: true } });
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= new Date()) throw notFound('Invitation');
    const existing = await this.prisma.user.findUnique({ where: { email: inv.email } });
    return { workspaceName: inv.workspace.name, email: inv.email, role: inv.role, existingUser: !!existing };
  }

  @Public()
  @Post('invites/accept')
  @ApiOperation({ summary: 'Accept an invitation (creates the account, or verifies the existing one)' })
  @ApiBody({ schema: jsonSchema(acceptInviteRequestSchema) })
  async acceptInvite(@Body(new ZodPipe(acceptInviteRequestSchema)) body: z.infer<typeof acceptInviteRequestSchema>, @Meta() meta: RequestMeta, @Req() req: RequestWithAuth, @Res({ passthrough: true }) res: Response): Promise<SessionInfo> {
    this.guard.checkOrigin(req);
    await this.rateLimit.enforce(`invite:${meta.ip}`, 30, 900);
    const inv = await this.prisma.invite.findUnique({ where: { tokenHash: sha256Hex(body.token) } });
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= new Date()) throw notFound('Invitation');
    const existing = await this.prisma.user.findUnique({ where: { email: inv.email } });
    let userId: string;
    if (existing) {
      if (!(await verifyPassword(existing.passwordHash, body.password))) throw forbidden('Enter the existing password for this account to accept');
      userId = existing.id;
    } else {
      const u = await this.prisma.user.create({ data: { email: inv.email, name: body.name, passwordHash: await hashPassword(body.password) } });
      userId = u.id;
    }
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invite.updateMany({ where: { id: inv.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (claimed.count !== 1) throw notFound('Invitation');
      await tx.membership.upsert({
        where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId } },
        create: { workspaceId: inv.workspaceId, userId, role: inv.role },
        update: {},
      });
      await this.audit.record({ workspaceId: inv.workspaceId, actorId: userId, action: 'member.joined', targetType: 'user', targetId: userId, metadata: { role: inv.role }, meta }, tx);
    });
    return this.startBrowserSession(userId, meta, res);
  }

  // ---- helpers ----

  private async verifyCredentials(email: string, password: string, meta: RequestMeta) {
    await this.rateLimit.enforce(`login-ip:${meta.ip}`, 30, 600);
    await this.rateLimit.enforce(`login-user:${email}`, 10, 900);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      await burnPasswordCheck(password);
    } else if (!user.disabledAt && (await verifyPassword(user.passwordHash, password))) {
      await this.rateLimit.reset(`login-user:${email}`);
      return user;
    }
    await this.audit.record({ actorId: user?.id ?? null, action: 'auth.login_failed', targetType: 'user', metadata: { email }, meta });
    throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', code: 'invalid_credentials', message: 'Invalid email or password' });
  }

  private async startBrowserSession(userId: string, meta: RequestMeta, res: Response): Promise<SessionInfo> {
    const s = await this.sessions.createBrowserSession(userId, meta);
    res.cookie(SESSION_COOKIE, s.token, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: s.expiresAt,
    });
    return this.sessionInfo(userId, s.sessionId, s.csrfToken);
  }

  async sessionInfo(userId: string, sessionId: string, csrfToken?: string): Promise<SessionInfo> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { include: { workspace: true }, orderBy: { createdAt: 'asc' } } },
    });
    return {
      user: { id: user.id, email: user.email, name: user.name, isInstanceAdmin: user.isInstanceAdmin, createdAt: user.createdAt.toISOString() },
      csrfToken,
      sessionId,
      workspaces: user.memberships.map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        slug: m.workspace.slug,
        role: m.role as Role,
        permissions: permissionsFor(m.role as Role),
      })),
    };
  }
}

export async function uniqueSlug(
  tx: { workspace: { findUnique(args: { where: { slug: string } }): Promise<unknown> } },
  name: string,
): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'workspace';
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await tx.workspace.findUnique({ where: { slug } }))) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}
