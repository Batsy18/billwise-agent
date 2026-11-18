import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { Role } from '../repositories/types';
import type { KeyMaterial } from './keys';

export interface JwtSettings {
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

export interface AuthContext {
  subscriberNo: string;
  role: Role;
}

const claimsSchema = z.object({
  sub: z.string().min(1),
  role: z.enum(['SUBSCRIBER', 'ADMIN']),
});

export function signAccessToken(
  keys: KeyMaterial,
  settings: JwtSettings,
  ctx: AuthContext,
): string {
  return jwt.sign({ role: ctx.role }, keys.privateKey, {
    algorithm: 'RS256',
    keyid: keys.kid,
    issuer: settings.issuer,
    audience: settings.audience,
    subject: ctx.subscriberNo,
    expiresIn: settings.ttlSeconds,
  });
}

/**
 * Verify signature, algorithm, issuer, audience and expiry. `algorithms: ['RS256']` is the
 * important line: without it a token "signed" with HS256 using the public key as the HMAC
 * secret could be accepted (algorithm-confusion attack). Returns null for any invalid token.
 */
export function verifyAccessToken(
  keys: KeyMaterial,
  settings: JwtSettings,
  token: string,
): AuthContext | null {
  try {
    const payload = jwt.verify(token, keys.publicKey, {
      algorithms: ['RS256'],
      issuer: settings.issuer,
      audience: settings.audience,
    });
    const claims = claimsSchema.safeParse(payload);
    return claims.success ? { subscriberNo: claims.data.sub, role: claims.data.role } : null;
  } catch {
    return null;
  }
}
