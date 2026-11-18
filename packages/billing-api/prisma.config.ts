import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Single .env at the repo root (see .env.example). Missing file is fine (CI, Cloud Run).
loadEnv({ path: path.resolve(__dirname, '../../.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/db/seed.ts',
  },
  // Read process.env directly instead of Prisma's env() helper: env() throws when the variable
  // is missing, but `prisma generate` (postinstall on a fresh clone) does not need a database.
  // Commands that do need it (migrate, db seed) fail with a clear Prisma error instead.
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
