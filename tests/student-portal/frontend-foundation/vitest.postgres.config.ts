import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/student-portal/frontend-foundation/*.postgres.ts'],
    hookTimeout: 30_000,
    testTimeout: 15_000,
    fileParallelism: false,
  },
});
