import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  isInstanceAdmin: boolean;
  via: 'cookie' | 'bearer';
}

export interface RequestWithAuth extends Request {
  auth?: AuthContext;
}

export const IS_PUBLIC = 'deployforge:public';
/** Marks a route as not requiring authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<RequestWithAuth>();
  if (!req.auth) throw new Error('Auth decorator used on a public route');
  return req.auth;
});

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { ip: req.ip ?? null, userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) || null };
});

export const SESSION_COOKIE = 'df_session';
export const CSRF_HEADER = 'x-csrf-token';
