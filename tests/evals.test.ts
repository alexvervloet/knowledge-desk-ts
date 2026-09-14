/**
 * The merge-gating evals must pass. These assert the same guarantees
 * `npm run evals` gates CI on, so a local `npm test` catches a regression too.
 * The evals reset the database themselves, so this file does not use cleanDb.
 */

import { afterAll, expect, it } from 'vitest'
import {
  fenceIntegrityEval,
  groundedAnswerEval,
  outputCheckEval,
  pathInjectionEval,
  permissionLeakEval,
  promptInjectionEval,
  shutdown,
  type EvalResult,
} from '../evals/run.ts'

afterAll(shutdown)

const EVALS: Array<[string, () => Promise<EvalResult>]> = [
  ['permission-leak', permissionLeakEval],
  ['grounded-answer', groundedAnswerEval],
  ['prompt-injection', promptInjectionEval],
  ['injection-via-path', pathInjectionEval],
  ['fence-integrity', fenceIntegrityEval],
  ['output-checks', outputCheckEval],
]

it.each(EVALS)('the %s eval passes', async (_name, run) => {
  const result = await run()
  expect(result.passed, result.detail).toBe(true)
})
