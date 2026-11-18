import { assertSeedAllowed } from './seed-guard';

describe('assertSeedAllowed — never wipe production by accident', () => {
  it('allows development and unset NODE_ENV', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development' }, [])).not.toThrow();
    expect(() => assertSeedAllowed({}, [])).not.toThrow();
  });

  it('refuses NODE_ENV=production without --force', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' }, [])).toThrow(/production/);
  });

  it('allows NODE_ENV=production with --force', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' }, ['--force'])).not.toThrow();
  });
});
