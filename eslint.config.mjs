// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/src/generated/**', // Prisma client
      '.remember/**',
    ],
  },
  js.configs.recommended,
  // Type-aware rules for TypeScript sources (each package's tsconfig.json covers src/).
  {
    files: ['packages/*/src/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  // supertest types `res.body` as `any`; asserting on it is the point of a test.
  // Application code keeps the full no-unsafe-* rules.
  {
    files: ['packages/*/src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  // CommonJS config files (jest.config.js etc.).
  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
  prettier,
);
