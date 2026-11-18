import type { Request, RequestHandler } from 'express';
import { AppError } from '../http/errors';
import type { Role } from '../repositories/types';
import type { KeyMaterial } from './keys';
import { verifyAccessToken, type AuthContext, type JwtSettings } from './tokens';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

const BEARER_RE = /^Bearer\s+(\S+)$/i;

/**
 * GCP API Gateway calls Cloud Run with its OWN identity token in `Authorization` and forwards
 * the user's original header as `X-Forwarded-Authorization`. So that one wins; plain
 * `Authorization` is the fallback for local runs and tests.
 */
export function bearerToken(req: Request): string | null {
  const header = req.get('x-forwarded-authorization') ?? req.get('authorization');
  return BEARER_RE.exec(header ?? '')?.[1] ?? null;
}

export function requireAuth(keys: KeyMaterial, settings: JwtSettings): RequestHandler {
  return (req, _res, next) => {
    const token = bearerToken(req);
    if (!token) throw new AppError('UNAUTHORIZED', 'Missing bearer token');
    const ctx = verifyAccessToken(keys, settings, token);
    if (!ctx) throw new AppError('UNAUTHORIZED', 'Invalid or expired token');
    req.auth = ctx;
    next();
  };
}

export function authContext(req: Request): AuthContext {
  if (!req.auth) throw new AppError('UNAUTHORIZED', 'Missing bearer token');
  return req.auth;
}

export function requireRole(role: Role): RequestHandler {
  return (req, _res, next) => {
    if (authContext(req).role !== role) {
      throw new AppError('FORBIDDEN', `This operation requires the ${role} role`);
    }
    next();
  };
}

/** Detailed / Pay: `role == ADMIN || sub == subscriberNo` (checked before any DB lookup). */
export function assertSelfOrAdmin(req: Request, subscriberNo: string): void {
  const ctx = authContext(req);
  if (ctx.role !== 'ADMIN' && ctx.subscriberNo !== subscriberNo) {
    throw new AppError('FORBIDDEN', 'You can only access your own account');
  }
}
