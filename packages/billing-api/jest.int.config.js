/**
 * Integration suite (`npm run test:int`): real Postgres (DATABASE_URL_TEST, must end in _test).
 * Not part of `npm test`, which stays DB-free.
 * @type {import('jest').Config}
 */
module.exports = {
  displayName: 'billing-api:int',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.int.test.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  globalSetup: '<rootDir>/src/test/int/global-setup.ts',
  maxWorkers: 1, // one shared database
  testTimeout: 30_000,
};
