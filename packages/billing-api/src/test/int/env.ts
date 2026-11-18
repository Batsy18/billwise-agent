import path from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(__dirname, '../../../../../.env'), quiet: true });

/**
 * The integration suite only ever touches a database whose name ends in "_test", so it can
 * never wipe the dev seed (billwise) or anything else by accident.
 */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST is not set (see .env.example)');
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(`Refusing to run integration tests against "${name}": name must end in _test`);
  }
  return url;
}
