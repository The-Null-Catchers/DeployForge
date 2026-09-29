import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { randomToken, sha256Hex, signAccessToken, verifyAccessToken } from '../crypto/tokens';
import type { TokenPair } from '@deployforge/contracts';
import type { AuthContext, RequestMeta } from './auth.types';

const unauthorized = (message = 'Authentication required', code = 'unauthenticated') =>
  new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', code, message });

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async createBrowserSession(userId: string, meta: RequestMeta): Promise<{ token: string; csrfToken: string; sessionId: string; expiresAt: Date }> {
    const token = randomToken('dfs_');
    const csrfToken = randomToken('', 24);
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_HOURS * 3600_000);
    const s = await this.prisma.session.create({
      data: { userId, kind: 'browser', tokenHash: sha256Hex(token), csrfSecret: csrfToken, userAgent: meta.userAgent, ip: meta.ip, expiresAt },
    });
    return { token, csrfToken, sessionId: s.id, expiresAt };
  }

  async createMobileSession(userId: string, deviceName: string, meta: RequestMeta): Promise<TokenPair> {
    const expiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86400_000);
    const s = await this.prisma.session.create({
      data: { userId, kind: 'mobile', deviceName, userAgent: meta.userAgent, ip: meta.ip, expiresAt },
    });
    return this.issuePair(s.id, userId, expiresAt);
  }

  private async issuePair(sessionId: string, userId: string, sessionExpiresAt: Date, previousId?: string): Promise<TokenPair> {
    const refreshToken = randomToken('dfr_');
    const refreshExpires = sessionExpiresAt;
    const rt = await this.prisma.refreshToken.create({
      data: { sessionId, tokenHash: sha256Hex(refreshToken), expiresAt: refreshExpires },
    });
    if (previousId) await this.prisma.refreshToken.update({ where: { id: previousId }, data: { replacedById: rt.id } });
    const exp = Math.floor(Date.now() / 1000) + this.config.ACCESS_TOKEN_TTL_SECONDS;
    return {
      accessToken: signAccessToken({ sid: sessionId, uid: userId, exp }, this.config.SESSION_SECRET),
      accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpires.toISOString(),
      sessionId,
    };
  }

  /**
   * Rotate a refresh token. Each token is single-use; presenting a token that
   * was already used means it leaked (or a client raced), so the whole
   * session is revoked (reuse detection). Clients must serialize refreshes.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const hash = sha256Hex(refreshToken);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const rt = await tx.refreshToken.findUnique({ where: { tokenHash: hash }, include: { session: { include: { user: true } } } });
      if (!rt) return { error: 'invalid' as const };
      const s = rt.session;
      if (rt.usedAt) return { error: 'reused' as const, sessionId: s.id };
      if (s.revokedAt || s.expiresAt <= now || rt.expiresAt <= now || s.user.disabledAt) return { error: 'expired' as const };
      // Conditional update so two concurrent refreshes cannot both succeed.
      const claimed = await tx.refreshToken.updateMany({ where: { id: rt.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count !== 1) return { error: 'reused' as const, sessionId: s.id };
      await tx.session.update({ where: { id: s.id }, data: { lastSeenAt: now } });
      const newToken = randomToken('dfr_');
      const created = await tx.refreshToken.create({ data: { sessionId: s.id, tokenHash: sha256Hex(newToken), expiresAt: s.expiresAt } });
      await tx.refreshToken.update({ where: { id: rt.id }, data: { replacedById: created.id } });
      const exp = Math.floor(Date.now() / 1000) + this.config.ACCESS_TOKEN_TTL_SECONDS;
      const pair: TokenPair = {
        accessToken: signAccessToken({ sid: s.id, uid: s.userId, exp }, this.config.SESSION_SECRET),
        accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
        refreshToken: newToken,
        refreshTokenExpiresAt: s.expiresAt.toISOString(),
        sessionId: s.id,
      };
      return { pair };
    });
    if ('pair' in result && result.pair) return result.pair;
    if (result.error === 'reused') {
      // Committed outside the transaction above so the revocation sticks.
      await this.revoke(result.sessionId, 'refresh_token_reuse');
      throw unauthorized('Refresh token reuse detected; the session has been revoked', 'refresh_token_reused');
    }
    if (result.error === 'expired') throw unauthorized('Session expired', 'session_expired');
    throw unauthorized('Invalid refresh token', 'invalid_refresh_token');
  }

  async authenticateCookie(token: string): Promise<{ ctx: AuthContext; csrfSecret: string } | null> {
    if (!token.startsWith('dfs_')) return null;
    const s = await this.prisma.session.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
    if (!s || s.kind !== 'browser' || !this.isLive(s) || s.user.disabledAt) return null;
    await this.touch(s.id, s.lastSeenAt);
    return {
      ctx: { userId: s.userId, sessionId: s.id, email: s.user.email, name: s.user.name, isInstanceAdmin: s.user.isInstanceAdmin, via: 'cookie' },
      csrfSecret: s.csrfSecret ?? '',
    };
  }

  async authenticateBearer(token: string): Promise<AuthContext | null> {
    const payload = verifyAccessToken(token, this.config.SESSION_SECRET);
    if (!payload) return null;
    const s = await this.prisma.session.findUnique({ where: { id: payload.sid }, include: { user: true } });
    if (!s || s.kind !== 'mobile' || s.userId !== payload.uid || s.revokedAt || s.expiresAt <= new Date() || s.user.disabledAt) return null;
    await this.touch(s.id, s.lastSeenAt);
    return { userId: s.userId, sessionId: s.id, email: s.user.email, name: s.user.name, isInstanceAdmin: s.user.isInstanceAdmin, via: 'bearer' };
  }

  /** Re-check that a session is still valid (used by long-lived SSE streams). */
  async isSessionValid(sessionId: string): Promise<boolean> {
    const s = await this.prisma.session.findUnique({ where: { id: sessionId }, include: { user: true } });
    return !!s && this.isLive(s) && !s.user.disabledAt;
  }

  private isLive(s: { revokedAt: Date | null; expiresAt: Date; lastSeenAt: Date; kind: string }): boolean {
    const now = Date.now();
    if (s.revokedAt || s.expiresAt.getTime() <= now) return false;
    if (s.kind === 'browser' && now - s.lastSeenAt.getTime() > this.config.SESSION_IDLE_HOURS * 3600_000) return false;
    return true;
  }

  private async touch(id: string, lastSeenAt: Date): Promise<void> {
    if (Date.now() - lastSeenAt.getTime() > 60_000) {
      await this.prisma.session.update({ where: { id }, data: { lastSeenAt: new Date() } });
    }
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
  }

  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const r = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return r.count;
  }
}
