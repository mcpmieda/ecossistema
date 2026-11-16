import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/student-portal/smoke/*.postgres.ts'],
    hookTimeout: 90_000,
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
