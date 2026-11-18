import { Router } from 'express';
import { z } from 'zod';
import type { KeyMaterial } from '../auth/keys';
import { parse } from '../http/middleware';
import type { AuthService } from '../services/auth.service';

const loginBody = z.object({
  subscriberNo: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(128),
});

export function authRoutes(auth: AuthService): Router {
  const r = Router();
  r.post('/api/v1/auth/login', async (req, res) => {
    const body = parse(loginBody, req.body);
    res.status(200).json(await auth.login(body.subscriberNo, body.password));
  });
  return r;
}

/** Public key set for GCP API Gateway (x-google-jwks_uri) and any other verifier. */
export function jwksRoutes(keys: KeyMaterial): Router {
  const r = Router();
  r.get('/.well-known/jwks.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ keys: [keys.jwk] });
  });
  return r;
}
