/**
 * Local dev: generate an RS256 key pair and store the private key as JWT_PRIVATE_KEY in the
 * repo-root .env (gitignored). The public key is derived at runtime and published via JWKS.
 *
 *   npm run keys:generate -w @billwise/billing-api            # refuses if a key already exists
 *   npm run keys:generate -w @billwise/billing-api -- --force # replace it (invalidates tokens)
 *
 * Cloud: the same PEM goes into Secret Manager instead (Phase 4).
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.resolve(__dirname, '../../../../.env');
const LINE_RE = /^JWT_PRIVATE_KEY=(.*)$/m;

/** Returns the new .env content, or throws if a key exists and `force` is false. */
export function upsertPrivateKey(envContent: string, pem: string, force: boolean): string {
  const line = `JWT_PRIVATE_KEY="${pem.trim().replace(/\n/g, '\\n')}"`;
  const match = LINE_RE.exec(envContent);
  if (match) {
    const current = (match[1] ?? '').replace(/^"|"$/g, '').trim();
    if (current && !force) {
      throw new Error('JWT_PRIVATE_KEY is already set in .env. Re-run with --force to replace it.');
    }
    return envContent.replace(LINE_RE, line);
  }
  const sep = envContent === '' || envContent.endsWith('\n') ? '' : '\n';
  return `${envContent}${sep}${line}\n`;
}

function main(): void {
  const force = process.argv.includes('--force');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  writeFileSync(ENV_PATH, upsertPrivateKey(current, privateKey, force));
  console.log(`Wrote a new RS256 JWT_PRIVATE_KEY to ${ENV_PATH}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
