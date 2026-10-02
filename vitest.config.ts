import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The real-provider test is opt-in: `npm run test:real`. Several tests here
    // assert mock-provider behaviour and fail when a key is present, so a suite
    // that ran both would be one you could not run with a key in the environment
    // — which is exactly how a refusing model went unnoticed in the first place.
    exclude: ['tests/real-provider.test.ts', 'node_modules/**'],
    // Every database test truncates the same tables. Running files in parallel
    // would have them truncate each other's rows mid-test, so the suite is
    // serial. The Python side gets this for free from pytest's default.
    fileParallelism: false,
    // Ingest tests wait on a drain working a real queue, and the real-provider
    // test makes a live API call.
    testTimeout: 30_000,
    // Tests drain the queue by calling runPending themselves. A background drain
    // kicked by an upload would race them for the same jobs. worker.test.ts turns
    // it back on where the background drain is the thing under test.
    env: { DRAIN_IN_PROCESS: '0' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // seed-corpus.ts is 200 lines of demo prose held in constants. It has no
      // behaviour to cover, and counting it drags the total without telling
      // anyone anything.
      exclude: ['src/seed-corpus.ts'],
      // The measured figures are 86/74/92/88. The floors sit below them
      // on purpose: the gate is here to catch a real regression rather than to
      // argue about a point of drift. Raise them as the thin modules get tests —
      // server.ts is at 0%, migrate.ts and tracing.ts around 64%,
      // and all three are process wiring rather than the parts a reviewer cares
      // about. The parts they do care about are covered: tenancy 95%, assistant
      // 100%, outputchecks 96%, ingest 96%, normalize 98%, providers 91%.
      thresholds: { lines: 82, functions: 85, branches: 68, statements: 80 },
      reporter: ['text', 'html'],
    },
  },
})
