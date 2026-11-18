import path from 'node:path';
import { CLOUD_ENV, ROOT, ROOT_ENV, envFiles, loadEnvFile } from './config';

describe('env files (local .env vs. --cloud / ENV_FILE overlay)', () => {
  it('local by default: only .env', () => {
    expect(envFiles([], {})).toEqual({ files: [ROOT_ENV] });
  });

  it('--cloud loads .env.cloud first, then .env for the rest', () => {
    expect(envFiles(['--only', 'a', '--cloud'], {})).toEqual({
      files: [CLOUD_ENV, ROOT_ENV],
      overlay: CLOUD_ENV,
    });
  });

  it('ENV_FILE is resolved against the repo root; --cloud wins over it', () => {
    const custom = path.join(ROOT, 'staging.env');
    expect(envFiles([], { ENV_FILE: 'staging.env' }).files).toEqual([custom, ROOT_ENV]);
    expect(envFiles(['--cloud'], { ENV_FILE: 'staging.env' }).overlay).toBe(CLOUD_ENV);
  });

  it('a missing overlay is an error with a hint (no silent fallback to local)', () => {
    expect(() => loadEnvFile([], { ENV_FILE: 'does-not-exist.env' })).toThrow(
      /does-not-exist\.env not found — copy \.env\.cloud\.example/,
    );
  });
});
