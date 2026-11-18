/** Runs once before the integration suite: create the _test database and migrate it. */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import { testDatabaseUrl } from './env';

export default async function globalSetup(): Promise<void> {
  const url = testDatabaseUrl();
  const dbName = new URL(url).pathname.slice(1); // validated: [a-z0-9_]+_test

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString(), connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      'Cannot reach PostgreSQL for the integration tests — is it running? (npm run db:up)',
      {
        cause: err,
      },
    );
  }
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }

  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
