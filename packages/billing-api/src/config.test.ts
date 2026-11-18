import { loadConfig } from './config';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: 'postgresql://x', JWT_PRIVATE_KEY: 'pem' })).toEqual({
      PORT: 3000,
      DATABASE_URL: 'postgresql://x',
      JWT_PRIVATE_KEY: 'pem',
      JWT_ISSUER: 'billwise-billing-api',
      JWT_AUDIENCE: 'billwise-api',
      JWT_TTL_SECONDS: 3600,
    });
  });

  it('names every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*JWT_PRIVATE_KEY/);
  });
});
