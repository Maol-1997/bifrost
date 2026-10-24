import { defineConfig } from 'vitest/config';

// Integration tests share one Postgres and one Redis, and deployment tool
// policies are global rows, so files run one after another.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
