/** Root Jest config: runs every workspace's test project in one report. */
/** @type {import('jest').Config} */
module.exports = {
  projects: ['<rootDir>/packages/*'],
  // Coverage scope must live here: with `projects`, per-project collectCoverageFrom is ignored.
  // Listing every source file makes untested ones (e.g. the Prisma repositories) show as 0%.
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    '!**/*.test.ts',
    '!**/src/generated/**', // Prisma client
    '!**/src/test/**', // test helpers + integration setup
  ],
};
