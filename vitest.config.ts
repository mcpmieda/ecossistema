import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Every other suite in the repository already budgets 15s or more; this one kept
    // the 5s default while the Portal moved to on-demand bundles, so mounting an area
    // could spend most of the budget on a cold dynamic import.
    testTimeout: 20_000,
    // Hooks pay the same cold imports (beforeAll loads real libraries), so they share the budget.
    hookTimeout: 20_000,
    setupFiles: ['tests/testing-library-v1.ts'],
    coverage: { reporter: ['text', 'json-summary'] },
  },
});
