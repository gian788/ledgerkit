import type { Config } from 'jest';

const sharedConfig = {
  preset: 'ts-jest',
  testEnvironment: 'node' as const,
  moduleNameMapper: {
    // ts-jest resolves .ts sources directly; strip the .js extension used in
    // compiled output so imports like './foo.js' resolve to './foo.ts'.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Resolve @ledger/shared from TypeScript source so tests don't require a
    // prior build of the shared package.
    '^@ledger/shared$': '<rootDir>/../shared/src/index.ts',
  },
};

const config: Config = {
  // Per-test timeout. beforeAll has its own timeout (passed as second arg)
  // so testcontainers startup is handled separately; 30s is plenty per test.
  testTimeout: 30_000,
  projects: [
    {
      ...sharedConfig,
      displayName: 'unit',
      testMatch: ['<rootDir>/src/__tests__/unit/**/*.test.ts'],
    },
    {
      ...sharedConfig,
      displayName: 'integration',
      testMatch: ['<rootDir>/src/__tests__/integration/**/*.test.ts'],
    },
  ],
};

export default config;
