/** @type {import('jest').Config} */
module.exports = {
  displayName: 'billing-api',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // The generated Prisma client imports siblings as './x.js'; map them to the .ts sources.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  // Unit tests only: the integration suite (*.int.test.ts) needs Postgres → jest.int.config.js
  testPathIgnorePatterns: ['/node_modules/', '\\.int\\.test\\.ts$'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/generated/**', // Prisma client
    '!src/test/**', // test helpers
  ],
};
