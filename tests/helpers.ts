/**
 * Shared test fixtures. Only tests that call `cleanDb()` touch the database, so
 * the smoke tests stay hermetic.
 */

import pg from 'pg'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { buildApp } from '../src/app.ts'
import { settings } from '../src/config.ts'
import { closePool } from '../src/db.ts'
import { applyPending } from '../src/migrate.ts'
import { authLimiter, limiter } from '../src/ratelimit.ts'
import type { FastifyInstance } from 'fastify'

// Truncating orgs cascades to everything that references it. platform_spend is
// listed separately because it deliberately has no org_id, so nothing cascades to
// it and a test's spend would otherwise carry into the next one. jobs likewise:
// it has an org_id but no foreign key to orgs, by design (see jobs.ts).
const DOMAIN_TABLES =
  'orgs, users, memberships, groups, group_members, sessions, platform_spend, jobs'

let migrated = false

/**
 * Truncate all domain tables before the test for a deterministic slate.
 *
 * Truncating orgs cascades to every org-scoped table (documents, answers,
 * audit_log, ...). Runs as the owner: TRUNCATE is not granted to the app role,
 * and is not subject to RLS anyway. Both in-memory rate limiters are reset too so
 * per-test request counts start fresh; the auth one keys on client address, which
 * every test shares, so without this the suite would throttle itself.
 */
export async function cleanDb(): Promise<void> {
  if (!migrated) {
    await applyPending()
    migrated = true
  }
  const client = new pg.Client({ connectionString: settings.databaseUrl })
  await client.connect()
  try {
    await client.query(`truncate ${DOMAIN_TABLES} cascade`)
  } finally {
    await client.end()
  }
  limiter.reset()
  authLimiter.reset()
}

/** Register `cleanDb` as this file's per-test reset, and close the pool at the end. */
export function useCleanDb(): void {
  beforeEach(cleanDb)
  afterAll(closePool)
}

/**
 * A running app, torn down after the file.
 *
 * `app.inject()` drives routes without a socket, which is what FastAPI's
 * TestClient does, so a test reads the same either side.
 */
export function useApp(): () => FastifyInstance {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })
  return () => app
}

/** The Authorization header for a bearer token. */
export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

export interface SignedUp {
  token: string
  org_id: string
  role: string
}

/**
 * A response body, typed.
 *
 * `inject().json()` is `any`, so every call site would otherwise either assert or
 * silently lose its types. One place to do the conversion, and one place to
 * tighten it if a test ever needs a real check.
 */
export function body<T>(res: { json: () => unknown }): T {
  return res.json() as T
}

/** Sign up an org and return its owner's session. */
export async function signup(
  app: FastifyInstance,
  slug = 'acme',
  email = `owner@${slug}.test`,
  password = 'pw-supersecret',
): Promise<SignedUp> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { org_slug: slug, org_name: slug, email, password },
  })
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`)
  return body<SignedUp>(res)
}

/** Add a member to the caller's org and log them in. */
export async function addMemberAndLogin(
  app: FastifyInstance,
  ownerToken: string,
  slug: string,
  email: string,
  role: 'admin' | 'member' = 'member',
  password = 'pw-supersecret',
): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/members',
    headers: auth(ownerToken),
    payload: { email, password, role },
  })
  if (created.statusCode !== 201) {
    throw new Error(`add member failed: ${created.statusCode} ${created.body}`)
  }
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password, org_slug: slug },
  })
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode} ${login.body}`)
  return body<SignedUp>(login).token
}

/** Parse an SSE body into the event objects it carries. */
export function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
}
