/**
 * Billing API server: env → config → Prisma → repositories → app → listen.
 *   npm run dev -w @billwise/billing-api     (tsx watch, local)
 *   npm start -w @billwise/billing-api       (built dist/, Cloud Run)
 */
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createApp } from './app';
import { loadKeyMaterial } from './auth/keys';
import { loadConfig } from './config';
import { createPrismaClient } from './db/client';
import { jsonErrorLog, requestLog } from './http/request-log';
import { createPrismaRepositories } from './repositories/prisma';
import { loadOpenApi } from './routes/docs.routes';

loadEnv({ path: path.resolve(__dirname, '../../../.env'), quiet: true }); // no-op in Cloud Run

function main(): void {
  const config = loadConfig(process.env);
  const prisma = createPrismaClient(config.DATABASE_URL);
  const app = createApp({
    repos: createPrismaRepositories(prisma),
    keys: loadKeyMaterial(config.JWT_PRIVATE_KEY),
    jwt: {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      ttlSeconds: config.JWT_TTL_SECONDS,
    },
    checkDatabase: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
    openapi: loadOpenApi(),
    ...(config.LOG_FORMAT === 'json'
      ? {
          requestLogger: requestLog({ projectId: config.GOOGLE_CLOUD_PROJECT }),
          log: jsonErrorLog(),
        }
      : {}),
  });

  const server = app.listen(config.PORT, () => {
    console.log(`billing-api listening on http://localhost:${config.PORT}  (docs: /api/v1/docs)`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM')); // Cloud Run sends SIGTERM
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
