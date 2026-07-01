import type { Config } from 'jest';

const sharedConfig = {
  preset: 'ts-jest',
  testEnvironment: 'node' as const,
  moduleNameMapper: {
    '^@ledger/shared$': '<rootDir>/../shared/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          baseUrl: '.',
          paths: { '@ledger/shared': ['../shared/src/index.ts'] },
        },
      },
    ] as [string, Record<string, unknown>],
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
    {
      ...sharedConfig,
      displayName: 'e2e',
      testMatch: ['<rootDir>/src/__tests__/e2e/**/*.test.ts'],
    },
  ],
};

export default config;
