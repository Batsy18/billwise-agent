/** Guard against wiping a production database by accident. */
export function assertSeedAllowed(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
): void {
  if (env.NODE_ENV === 'production' && !argv.includes('--force')) {
    throw new Error(
      'Refusing to seed with NODE_ENV=production. Pass --force if you really mean it.',
    );
  }
}
