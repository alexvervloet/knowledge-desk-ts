import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Every database test truncates the same tables. Running files in parallel
    // would have them truncate each other's rows mid-test, so the suite is
    // serial. The Python side gets this for free from pytest's default.
    fileParallelism: false,
    // Ingest tests wait on a worker draining a real queue, and the real-provider
    // test makes a live API call.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // bench.ts is a developer benchmarking harness, not shipped behaviour.
      // Counting it against the total only invites tests written for the metric.
      exclude: ['src/bench.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
      reporter: ['text', 'html'],
    },
  },
})
