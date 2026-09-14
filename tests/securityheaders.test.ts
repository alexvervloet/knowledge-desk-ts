/**
 * Security response headers. Hermetic: no route here touches the database.
 *
 * The SPA is served same-origin from the API in production, so these land on the
 * page that holds the session token.
 */

import { expect, it } from 'vitest'
import { HEADERS } from '../src/plugins/securityheaders.ts'
import { auth, signup, useApp, useCleanDb } from './helpers.ts'

const app = useApp()
useCleanDb()

const csp = async (): Promise<string> => {
  const res = await app().inject({ method: 'GET', url: '/healthz' })
  return String(res.headers['content-security-policy'])
}

it('sets every header on an API response', async () => {
  const res = await app().inject({ method: 'GET', url: '/healthz' })
  for (const [name, value] of Object.entries(HEADERS)) {
    expect(res.headers[name], name).toBe(value)
  }
})

/**
 * A 401 is still a response the browser renders, and the paths that return one
 * are the paths an attacker reaches for.
 */
it('sets them on an error response too', async () => {
  const res = await app().inject({ method: 'GET', url: '/me' })
  expect(res.statusCode).toBe(401)
  expect(res.headers).toHaveProperty('content-security-policy')
})

it('restricts scripts to our own origin', async () => {
  const policy = await csp()
  expect(policy).toContain("script-src 'self'")
  expect(policy.split('script-src')[1]?.split(';')[0]).not.toContain("'unsafe-inline'")
  expect(policy).not.toContain("'unsafe-eval'")
})

it('stops the page being framed or having its base rewritten', async () => {
  const policy = await csp()
  expect(policy).toContain("frame-ancestors 'none'")
  expect(policy).toContain("base-uri 'self'")
  expect(policy).toContain("object-src 'none'")
})

/**
 * The Python side exempts FastAPI's /docs from the CSP, because Swagger UI loads
 * its bundle from a CDN that `script-src 'self'` blocks. Fastify ships no such
 * page, so the exemption is gone and there is nothing left that skips the policy.
 * Asserted, because an exemption re-added later should have to justify itself
 * against a test rather than slip in.
 */
it('has no route exempt from the policy', async () => {
  for (const url of ['/docs', '/redoc', '/healthz', '/me', '/does-not-exist']) {
    const res = await app().inject({ method: 'GET', url })
    expect(res.headers['content-security-policy'], url).toBe(HEADERS['content-security-policy'])
  }
})

/**
 * The SSE route writes to reply.raw, where Fastify's onSend hook never runs, so
 * the headers are set there by hand from the same object. Without that, the one
 * response that streams model output would be the one without a policy — and it
 * is the response most likely to carry text an attacker wrote.
 */
it('sets them on the streaming route, where the onSend hook does not run', async () => {
  const { token } = await signup(app(), 'acme')
  const res = await app().inject({
    method: 'POST',
    url: '/ask',
    headers: auth(token),
    payload: { question: 'anything at all' },
  })

  expect(res.statusCode).toBe(200)
  expect(res.headers['content-type']).toContain('text/event-stream')
  for (const [name, value] of Object.entries(HEADERS)) {
    expect(res.headers[name], `${name} on the streamed response`).toBe(value)
  }
})
