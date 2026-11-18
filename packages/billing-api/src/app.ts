/**
 * Express app factory. No I/O here: the caller injects repositories, keys and settings, so
 * the unit tests build it with in-memory fakes and src/index.ts with Prisma.
 */
import express, { type Express } from 'express';
import type { KeyMaterial } from './auth/keys';
import { requireAuth } from './auth/middleware';
import type { JwtSettings } from './auth/tokens';
import { errorHandler, notFound, traceId } from './http/middleware';
import type { Repositories } from './repositories/types';
import { authRoutes, jwksRoutes } from './routes/auth.routes';
import { billRoutes } from './routes/bills.routes';
import { docsRoutes } from './routes/docs.routes';
import { healthRoutes } from './routes/health.routes';
import { paymentRoutes } from './routes/payments.routes';
import { usageRoutes } from './routes/usage.routes';
import { AuthService } from './services/auth.service';
import { BillService } from './services/bill.service';
import { PaymentService } from './services/payment.service';
import { UsageService } from './services/usage.service';

export interface AppDeps {
  repos: Repositories;
  keys: KeyMaterial;
  jwt: JwtSettings;
  checkDatabase: () => Promise<void>;
  /** Parsed docs/openapi.yaml; Swagger UI is mounted when provided. */
  openapi?: Record<string, unknown>;
  log?: (msg: string, err: unknown) => void;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true); // behind GCP API Gateway / Cloud Run front end
  app.use(traceId);
  app.use(express.json({ limit: '16kb' }));

  const authenticate = requireAuth(deps.keys, deps.jwt);
  const { repos } = deps;

  app.use(healthRoutes(deps.checkDatabase));
  app.use(jwksRoutes(deps.keys));
  app.use(authRoutes(new AuthService(repos.subscribers, deps.keys, deps.jwt)));
  app.use(usageRoutes(new UsageService(repos.subscribers, repos.usage), authenticate));
  app.use(billRoutes(new BillService(repos.subscribers, repos.usage, repos.bills), authenticate));
  app.use(paymentRoutes(new PaymentService(repos.payments), authenticate));
  if (deps.openapi) app.use(docsRoutes(deps.openapi));

  app.use(notFound);
  app.use(errorHandler(deps.log ?? ((msg, err) => console.error(msg, err))));
  return app;
}
