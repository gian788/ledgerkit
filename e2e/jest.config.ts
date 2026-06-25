import type { Config } from 'jest';

const moduleNameMapper = {
  '^@ledger/shared$': '<rootDir>/../packages/shared/src/index.ts',
  '^@ledger/api/(.*)$': '<rootDir>/../packages/api/src/$1',
  '^@ledger/outbox-relay/(.*)$': '<rootDir>/../packages/outbox-relay/src/$1',
  '^@ledger/settlement-worker/(.*)$': '<rootDir>/../packages/settlement-worker/src/$1',
  '^@ledger/audit-consumer/(.*)$': '<rootDir>/../packages/audit-consumer/src/$1',
};

const config: Config = {
  testEnvironment: 'node',
  testTimeout: 60_000,
  forceExit: true,
  testMatch: ['<rootDir>/**/*.test.ts'],
  moduleNameMapper,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};

export default config;
