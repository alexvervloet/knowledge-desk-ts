import { defineConfig } from 'vitest/config'

/**
 * The opt-in config for the one test that calls a real model.
 *
 * A second file rather than a CLI flag, because the default config *excludes*
 * that test and vitest applies exclude before a filename filter — so
 * `vitest run tests/real-provider.test.ts` finds nothing and exits 1, which
 * reads exactly like a pass if you are not watching.
 *
 * Standalone rather than merged onto the default, because `mergeConfig`
 * concatenates `include` and would run the whole suite. That is worse than it
 * sounds: several tests assert mock-provider behaviour and fail when a key is
 * present, so the run that finally exercises a real model is also the run that
 * reports five unrelated failures.
 */
export default defineConfig({
  test: {
    include: ['tests/real-provider.test.ts'],
    exclude: ['node_modules/**'],
    fileParallelism: false,
    // One live call, and the model may think for a while even at effort low.
    testTimeout: 120_000,
  },
})
