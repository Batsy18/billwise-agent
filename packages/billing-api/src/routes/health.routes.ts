import { Router } from 'express';
import { AppError } from '../http/errors';

/**
 * /health       liveness — process is up, never touches the DB (Cloud Run startup/liveness probe)
 * /health/ready readiness — DB answers `SELECT 1`, otherwise 503 SERVICE_UNAVAILABLE
 */
export function healthRoutes(checkDatabase: () => Promise<void>): Router {
  const r = Router();
  r.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  r.get('/api/v1/health/ready', async (_req, res) => {
    try {
      await checkDatabase();
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE', 'Database is not reachable');
    }
    res.json({ status: 'ready', database: 'up' });
  });
  return r;
}
