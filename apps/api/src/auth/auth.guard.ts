import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CONFIG, type AppConfig } from '../config/config';
import { safeEqual } from '../crypto/tokens';
import { CSRF_HEADER, IS_PUBLIC, SESSION_COOKIE, type RequestWithAuth } from './auth.types';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global authentication guard. Every route requires authentication unless
 * marked @Public(). Browser requests authenticate with an HttpOnly session
 * cookie and must present the per-session CSRF token on unsafe methods.
 * Native clients use short-lived bearer access tokens (no ambient
 * credentials, so no CSRF exposure).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<RequestWithAuth>();
    const authz = req.headers.authorization;

    if (authz?.startsWith('Bearer ')) {
      const ctx = await this.sessions.authenticateBearer(authz.slice(7).trim());
      if (ctx) req.auth = ctx;
      else if (!isPublic) throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', code: 'invalid_access_token', message: 'Access token is invalid or expired' });
      return true;
    }

    const cookie = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (cookie) {
      const result = await this.sessions.authenticateCookie(cookie);
      if (result) {
        if (!SAFE_METHODS.has(req.method)) {
          this.checkOrigin(req);
          const header = req.headers[CSRF_HEADER];
          if (typeof header !== 'string' || !result.csrfSecret || !safeEqual(header, result.csrfSecret)) {
            throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'csrf_failed', message: 'Missing or invalid CSRF token' });
          }
        }
        req.auth = result.ctx;
        return true;
      }
    }
    if (isPublic) return true;
    throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', code: 'unauthenticated', message: 'Authentication required' });
  }

  /** Defense in depth: reject cross-origin unsafe requests carrying cookies. */
  checkOrigin(req: RequestWithAuth): void {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = new Set([new URL(this.config.PUBLIC_URL).origin]);
    if (this.config.DASHBOARD_HOSTNAME) {
      allowed.add(`https://${this.config.DASHBOARD_HOSTNAME}`);
      allowed.add(`http://${this.config.DASHBOARD_HOSTNAME}`);
    }
    if (!allowed.has(origin)) {
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'bad_origin', message: 'Cross-origin request rejected' });
    }
  }
}
