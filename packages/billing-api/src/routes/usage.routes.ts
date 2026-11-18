import { Router, type RequestHandler } from 'express';
import { requireRole } from '../auth/middleware';
import { parse } from '../http/middleware';
import type { UsageService } from '../services/usage.service';
import { usageBody } from './schemas';

export function usageRoutes(usage: UsageService, authenticate: RequestHandler): Router {
  const r = Router();
  r.post('/api/v1/usage', authenticate, requireRole('ADMIN'), async (req, res) => {
    const { usageType, ...period } = parse(usageBody, req.body);
    res.status(201).json(await usage.add(period, usageType));
  });
  return r;
}
