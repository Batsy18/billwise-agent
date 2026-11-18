/** @type {import('jest').Config} */
module.exports = {
  displayName: 'billing-api',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // The generated Prisma client imports siblings as './x.js'; map them to the .ts sources.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
