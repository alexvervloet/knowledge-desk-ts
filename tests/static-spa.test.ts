/**
 * Serving the built SPA from the API, which is how production runs.
 *
 * Its own file because it needs SERVE_STATIC on and a real `frontend/dist`, and
 * because the bug it exists for only appears in that mode: the 404 handler was
 * registered twice — once for the API, once for the SPA fallback — and Fastify
 * allows exactly one per prefix, so the app threw at boot. Nothing in the rest of
 * the suite sets SERVE_STATIC, so nothing caught it until the server was started
 * by hand.
 */

import { stat } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.ts'
import { settings } from '../src/config.ts'
import { HEADERS } from '../src/plugins/securityheaders.ts'

const built = await stat(settings.staticDir).catch(() => null)
const hasBuild = built?.isDirectory() ?? false

describe.skipIf(!hasBuild)('serving the built SPA', () => {
  let app: FastifyInstance
  const wasServing = settings.serveStatic

  beforeAll(async () => {
    settings.serveStatic = true
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    settings.serveStatic = wasServing
  })

  it('boots with the static mount and the API together', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
  })

  it('serves index.html at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<!doctype html>')
  })

  it('falls a client route through to the SPA', async () => {
    const res = await app.inject({ method: 'GET', url: '/sources' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<!doctype html>')
  })

  it('still answers an unmatched non-GET with a JSON 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ detail: 'not found' })
  })

  /**
   * The document that holds the session token in localStorage. If any response
   * gets the policy, it has to be this one.
   */
  it('puts the security headers on the SPA document', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    for (const [name, value] of Object.entries(HEADERS)) {
      expect(res.headers[name], name).toBe(value)
    }
  })
})
