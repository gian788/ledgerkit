import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // testcontainers can take 30-60s to pull and start on first run
  testTimeout: 60000,
  // Resolve @ledger/shared directly from TypeScript source so tests don't
  // require a prior build of the shared package.
  moduleNameMapper: {
    // ts-jest resolves .ts sources directly; strip the .js extension that the
    // compiled output uses so imports like './foo.js' resolve to './foo.ts'.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@ledger/shared$': '<rootDir>/../shared/src/index.ts',
  },
};

export default config;
