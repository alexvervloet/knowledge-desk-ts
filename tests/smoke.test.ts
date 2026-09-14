/**
 * Smoke tests: the health probe, and that the assistant is behind auth.
 *
 * These run with no database and no keys, so CI has a fast, hermetic gate before
 * the suites that need Postgres. The ask contract itself is an authenticated SSE
 * stream, covered in assistant.test.ts.
 */

import { expect, it } from 'vitest'
import { body, useApp } from './helpers.ts'

const app = useApp()

it('healthz reports the mock provider', async () => {
  const res = await app().inject({ method: 'GET', url: '/healthz' })
  expect(res.statusCode).toBe(200)
  const payload = body<{ status: string; provider: string }>(res)
  expect(payload.status).toBe('ok')
  expect(payload.provider).toBe('mock')
})

it('ask requires auth', async () => {
  const res = await app().inject({ method: 'POST', url: '/ask', payload: { question: 'hello' } })
  expect(res.statusCode).toBe(401)
})
