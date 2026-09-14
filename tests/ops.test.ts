/**
 * Phase 5: operational controls. Per-org budget and question caps block the
 * model call with a loud frame; a per-user rate limit returns 429; ingest
 * respects storage caps; every answer records its usage; and key actions land in
 * the audit log an admin can read.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as accounts from '../src/accounts.ts'
import { answerStream, type AskEvent } from '../src/assistant.ts'
import { settings } from '../src/config.ts'
import { connect } from '../src/db.ts'
import { QuotaExceeded } from '../src/errors.ts'
import { runPending } from '../src/ingest.ts'
import { MockAnswerProvider } from '../src/providers.ts'
import { TokenBucketLimiter, authLimiter } from '../src/ratelimit.ts'
import { TenantScope } from '../src/tenancy.ts'
import { auth, body, signup as signupOrg, sseEvents, useApp, useCleanDb } from './helpers.ts'

const app = useApp()
useCleanDb()

const PW = 'pw-supersecret'
type Event = Record<string, unknown>

/**
 * Restore the settings this file reaches into.
 *
 * Python's monkeypatch undoes a setattr automatically at teardown. `settings` is
 * a plain object here, so a test that changes a cap has to put it back or every
 * later test in the file inherits it. `provider` is skipped because it is a
 * getter derived from two other fields: spreading captures its value, and
 * assigning that value back throws.
 */
const { provider: _derived, ...ORIGINAL } = settings
afterEach(() => {
  Object.assign(settings, ORIGINAL)
  vi.restoreAllMocks()
})

async function signup(slug: string, email: string): Promise<string> {
  return (await signupOrg(app(), slug, email, PW)).token
}

function post(token: string, url: string, payload: object) {
  return app().inject({ method: 'POST', url, headers: auth(token), payload })
}

async function login(email: string, slug: string): Promise<string> {
  const res = await app().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PW, org_slug: slug },
  })
  return body<{ token: string }>(res).token
}

async function addMember(owner: string, email: string): Promise<string> {
  const res = await post(owner, '/members', { email, password: PW, role: 'member' })
  return body<{ user_id: string }>(res).user_id
}

async function upload(
  token: string,
  documents: Array<{ path: string; content: string; acl?: string[] }>,
) {
  const res = await post(token, '/sources/folder', { documents })
  if (res.statusCode === 202) await runPending()
  return res
}

async function askEvents(token: string, question: string): Promise<Event[]> {
  const res = await post(token, '/ask', { question })
  expect(res.statusCode).toBe(200)
  return sseEvents(res.body)
}

function types(events: Event[]): Set<string> {
  return new Set(events.map((e) => String(e.type)))
}

function find(events: Event[], type: string): Event {
  const found = events.find((e) => e.type === type)
  if (found === undefined) throw new Error(`no ${type} frame in ${JSON.stringify(types(events))}`)
  return found
}

async function orgOf(token: string): Promise<string> {
  return body<{ org_id: string }>(
    await app().inject({ method: 'GET', url: '/me', headers: auth(token) }),
  ).org_id
}

async function scopeFor(token: string): Promise<TenantScope> {
  const me = body<{ user_id: string; org_id: string; role: string; email: string }>(
    await app().inject({ method: 'GET', url: '/me', headers: auth(token) }),
  )
  return new TenantScope({
    userId: me.user_id,
    orgId: me.org_id,
    role: me.role,
    email: me.email,
  })
}

// --- budget and question caps ---------------------------------------------

describe('budget and question caps', () => {
  it('blocks the model call when over budget', async () => {
    settings.dailyBudgetUsd = 0.0 // everything is over budget
    const token = await signup('acme', 'o@acme.test')
    const events = await askEvents(token, 'anything?')
    const error = String(find(events, 'error').message)
    expect(error).toContain('[LIMIT]')
    expect(error).toContain('budget')
    expect(types(events)).not.toContain('sources') // never retrieved, never answered
  })

  it('blocks after the monthly question cap', async () => {
    settings.monthlyQuestionCap = 1
    const token = await signup('acme', 'o@acme.test')
    expect(types(await askEvents(token, 'first?'))).not.toContain('error') // under the cap
    const second = await askEvents(token, 'second?')
    const error = String(find(second, 'error').message)
    expect(error).toContain('[LIMIT]')
    expect(error).toContain('monthly')
  })

  it('records a blocked question', async () => {
    settings.dailyBudgetUsd = 0.0
    const token = await signup('acme', 'o@acme.test')
    const aid = String(find(await askEvents(token, 'q?'), 'meta').answer_id)
    // RLS: reads need the org context set.
    const row = await connect(await orgOf(token), (conn) =>
      conn.require<{ blocked: boolean }>('select blocked from answers where id = $1', [aid]),
    )
    expect(row.blocked).toBe(true)
  })

  /**
   * Per-org caps bound one tenant, not the bill: signup is open, so a fresh org
   * comes with a fresh budget. The deployment-wide ceiling is the number that
   * actually bounds a day's spend, and it has to bite a brand new org that has
   * not spent a cent of its own allowance.
   */
  it('lets the platform budget block an org that is under its own', async () => {
    settings.platformDailyBudgetUsd = 1.0
    const spent = await signup('acme', 'o@acme.test')
    const spentScope = await scopeFor(spent)
    const seeded = String(find(await askEvents(spent, 'seed the ledger'), 'meta').answer_id)
    await spentScope.finalizeAnswer(seeded, 1, 1, 1.5)

    // A different org, untouched budget of its own.
    const fresh = await signup('globex', 'o@globex.test')
    expect(await (await scopeFor(fresh)).spendLast24h()).toBe(0.0)
    const events = await askEvents(fresh, 'anything at all')
    expect(String(find(events, 'error').message)).toContain('service daily budget exhausted')
  })
})

// --- per-user rate limit ---------------------------------------------------

describe('the per-user rate limit', () => {
  it('returns 429', async () => {
    settings.rateBurst = 2
    settings.ratePerMin = 1 // negligible refill during the test
    const token = await signup('acme', 'o@acme.test')
    const codes: number[] = []
    for (let i = 0; i < 3; i++) codes.push((await post(token, '/ask', { question: 'hi' })).statusCode)
    expect(codes).toEqual([200, 200, 429])
  })

  it('is per user', async () => {
    settings.rateBurst = 1
    settings.ratePerMin = 1
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'dev@acme.test')
    const dev = await login('dev@acme.test', 'acme')
    expect((await post(owner, '/ask', { question: 'hi' })).statusCode).toBe(200)
    // The owner is now rate-limited, but the member has an independent bucket.
    expect((await post(owner, '/ask', { question: 'hi' })).statusCode).toBe(429)
    expect((await post(dev, '/ask', { question: 'hi' })).statusCode).toBe(200)
  })
})

// --- auth rate limit and the timing oracle ---------------------------------

describe('the auth rate limit', () => {
  it('throttles login', async () => {
    settings.authRateBurst = 3
    settings.authRatePerMin = 1 // negligible refill
    await signup('acme', 'o@acme.test')
    authLimiter.reset() // signup consumed a token from the same bucket
    const bad = { email: 'o@acme.test', password: 'wrongbutlongenough' }
    const codes: number[] = []
    for (let i = 0; i < 4; i++) {
      codes.push(
        (await app().inject({ method: 'POST', url: '/auth/login', payload: bad })).statusCode,
      )
    }
    expect(codes).toEqual([401, 401, 401, 429])
  })

  /**
   * The per-org spend and question caps are only a bound if orgs are not free to
   * mint, so the signup route needs the same throttle as login.
   */
  it('throttles signup', async () => {
    settings.authRateBurst = 2
    settings.authRatePerMin = 1
    const codes: number[] = []
    for (let i = 0; i < 3; i++) {
      const res = await app().inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { org_slug: `org-${i}`, org_name: 'O', email: `o${i}@x.test`, password: PW },
      })
      codes.push(res.statusCode)
    }
    expect(codes).toEqual([201, 201, 429])
  })

  it('is independent of the ask limit', async () => {
    settings.authRateBurst = 1
    settings.authRatePerMin = 1
    const token = await signup('acme', 'o@acme.test')
    // Signup exhausted the auth bucket, but asking is a separate limiter.
    const login = await app().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'o@acme.test', password: PW },
    })
    expect(login.statusCode).toBe(429)
    expect((await post(token, '/ask', { question: 'hi' })).statusCode).toBe(200)
  })

  /**
   * A miss used to skip bcrypt entirely, so response time answered "does this
   * email have an account" — roughly 4ms against 240ms. Both paths must hash.
   */
  it('costs the same whether or not the account exists', async () => {
    await signup('acme', 'o@acme.test')
    const bad = 'wrongbutlongenough'

    const timed = async (email: string): Promise<number> => {
      authLimiter.reset()
      const start = performance.now()
      const res = await app().inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: bad },
      })
      expect(res.statusCode).toBe(401)
      return performance.now() - start
    }

    const best = async (email: string): Promise<number> => {
      const runs: number[] = []
      for (let i = 0; i < 3; i++) runs.push(await timed(email))
      return Math.min(...runs)
    }

    const known = await best('o@acme.test')
    const unknown = await best('nobody@acme.test')
    // Generous bound: the point is that one is not an order of magnitude faster,
    // not that a shared CI runner produces stable timings.
    expect(unknown / known, `known=${known}ms unknown=${unknown}ms`).toBeGreaterThan(0.5)
    expect(unknown / known, `known=${known}ms unknown=${unknown}ms`).toBeLessThan(2.0)
  })

  /**
   * One entry per key, kept for the life of the process, is a slow leak. A bucket
   * idle long enough has refilled to full, so it is indistinguishable from a key
   * never seen and there is nothing to lose by dropping it.
   */
  it('evicts idle buckets', () => {
    let now = 0
    const limiter = new TokenBucketLimiter(() => now)
    for (let i = 0; i < 1200; i++) limiter.check(`key-${i}`)
    expect(limiter.size).toBe(1200)

    now += TokenBucketLimiter.EVICT_AFTER_SECONDS + 1
    limiter.check('someone-new')
    expect(limiter.size, 'idle buckets should be gone').toBe(1)
  })
})

it('purges expired sessions', async () => {
  const token = await signup('acme', 'o@acme.test')
  await connect(null, (conn) =>
    conn.exec("update sessions set expires_at = now() - interval '1 day'"),
  )

  const me = await app().inject({ method: 'GET', url: '/me', headers: auth(token) })
  expect(me.statusCode).toBe(401) // already refused
  expect(await accounts.purgeExpiredSessions()).toBe(1)
  const left = await connect(null, (conn) =>
    conn.require<{ n: string }>('select count(*) as n from sessions'),
  )
  expect(Number(left.n)).toBe(0)
})

/**
 * The cap was read in one transaction and the write happened in another, so two
 * uploads could each see room only one of them had. The check now runs inside the
 * write transaction behind a lock on the org row.
 */
it('will not let two concurrent uploads both pass the same cap', async () => {
  settings.orgDocCap = 10
  const token = await signup('acme', 'o@acme.test')
  const scope = await scopeFor(token)

  const docs = Array.from({ length: 6 }, (_, i) => ({ path: `a${i}.txt`, content: 'x' }))
  const other = Array.from({ length: 6 }, (_, i) => ({ path: `b${i}.txt`, content: 'x' }))
  // Started together, not awaited in turn: both transactions are open at once,
  // which is the only arrangement in which the lock is doing anything.
  const settled = await Promise.allSettled([
    scope.syncSource('src-0', docs),
    scope.syncSource('src-1', other),
  ])

  const rejected = settled.filter((r) => r.status === 'rejected')
  expect(rejected.length, '6 + 6 documents cannot both fit under a cap of 10').toBeGreaterThan(0)
  for (const r of rejected) {
    expect(r.reason).toBeInstanceOf(QuotaExceeded)
  }
  const total = await connect(scope.orgId, (conn) =>
    conn.require<{ n: string }>('select count(*) as n from documents where org_id = $1', [
      scope.orgId,
    ]),
  )
  expect(Number(total.n)).toBeLessThanOrEqual(10)
})

// --- ingest storage cap ----------------------------------------------------

describe('the ingest caps', () => {
  it('rejects an oversized upload', async () => {
    settings.orgStorageBytesCap = 100
    const token = await signup('acme', 'o@acme.test')
    const res = await upload(token, [{ path: 'big.txt', content: 'x'.repeat(500) }])
    expect(res.statusCode).toBe(413)
    expect(body<{ detail: string }>(res).detail).toContain('storage')
  })

  it('rejects too many documents', async () => {
    settings.orgDocCap = 1
    const token = await signup('acme', 'o@acme.test')
    const res = await upload(token, [
      { path: 'a.txt', content: 'a' },
      { path: 'b.txt', content: 'b' },
    ])
    expect(res.statusCode).toBe(413)
    expect(body<{ detail: string }>(res).detail).toContain('document')
  })
})

// --- cost ledger -----------------------------------------------------------

interface AnswerRow {
  [column: string]: unknown
  input_tokens: number
  output_tokens: number
  cost_usd: string
  refused: boolean
  blocked: boolean
  usage_estimated: boolean
}

async function answerRow(token: string, answerId: string): Promise<AnswerRow> {
  return connect(await orgOf(token), (conn) =>
    conn.require<AnswerRow>(
      'select input_tokens, output_tokens, cost_usd, refused, blocked, usage_estimated' +
        ' from answers where id = $1',
      [answerId],
    ),
  )
}

it('records usage on an answer', async () => {
  const token = await signup('acme', 'o@acme.test')
  await upload(token, [
    { path: 'doc.txt', content: 'the sky is blue today', acl: ['public-to-org'] },
  ])
  const aid = String(find(await askEvents(token, 'the sky is blue today'), 'meta').answer_id)
  const row = await answerRow(token, aid)
  expect(row.output_tokens).toBeGreaterThan(0)
  expect(row.refused).toBe(false)
  expect(row.blocked).toBe(false)
  expect(row.usage_estimated).toBe(false) // reported by the provider, not inferred
})

// --- billing a stream that does not finish ---------------------------------

describe('billing a stream that does not finish', () => {
  /**
   * Pull frames until the first token arrives, and return the answer id.
   *
   * Driven by hand rather than with `for await ... of` and a `break`, and that is
   * the whole reason this helper exists: breaking out of a `for await` loop calls
   * `return()` on the iterator automatically, so the generator would already be
   * closed and billed before the test reached the line that means to close it.
   * Python's `for` does not do that, so the Python version of these tests can
   * loop and break freely. Here, a test that wants to control when the stream
   * closes has to hold the iterator itself.
   */
  async function consumeUntilFirstToken(
    stream: AsyncGenerator<AskEvent, void, undefined>,
  ): Promise<string> {
    let answerId = ''
    for (;;) {
      const { value, done } = await stream.next()
      if (done || value === undefined) throw new Error('stream ended before a token')
      if (value.type === 'meta') answerId = value.answer_id
      if (value.type === 'token') return answerId
    }
  }

  /**
   * A client that disconnects before the final usage frame used to leave the row
   * at zero tokens and zero dollars, so the budget never advanced even though the
   * model had already generated. Aborting every request just before the end was a
   * way to spend without ever being billed.
   */
  it('still bills an abandoned stream', async () => {
    const token = await signup('acme', 'o@acme.test')
    await upload(token, [
      { path: 'doc.txt', content: 'the sky is blue today', acl: ['public-to-org'] },
    ])

    const stream = answerStream(await scopeFor(token), 'the sky is blue today', 5)
    const answerId = await consumeUntilFirstToken(stream)
    // `return()` is what Python's close() is: it runs the generator's finally
    // block, which is where the billing for an unfinished stream happens.
    await stream.return(undefined)

    const row = await answerRow(token, answerId)
    expect(row.output_tokens, 'an abandoned stream must still book what it consumed').toBeGreaterThan(0)
    expect(row.usage_estimated).toBe(true)
  })

  /**
   * The estimate is keyed on having streamed something, so a refusal — where no
   * provider call happens at all — must not invent a charge.
   */
  it('does not bill a stream that never reached the model', async () => {
    const token = await signup('acme', 'o@acme.test')
    const events = await askEvents(token, 'nothing here matches this')
    const answerId = String(find(events, 'meta').answer_id)

    const row = await answerRow(token, answerId)
    expect(row.input_tokens).toBe(0)
    expect(row.output_tokens).toBe(0)
    expect(Number(row.cost_usd)).toBe(0)
    expect(row.usage_estimated).toBe(false)
  })

  /** The point of billing it: the spend the budget sees must move. */
  it('counts an abandoned stream toward the org budget', async () => {
    const token = await signup('acme', 'o@acme.test')
    await upload(token, [
      { path: 'doc.txt', content: 'the sky is blue today', acl: ['public-to-org'] },
    ])
    const scope = await scopeFor(token)

    const stream = answerStream(scope, 'the sky is blue today', 5)
    await consumeUntilFirstToken(stream)
    // The mock provider is free, so price the estimate to prove the wiring. It
    // has to be in place before the close, because the close is what calls it.
    vi.spyOn(MockAnswerProvider.prototype, 'estimate').mockReturnValue({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.25,
    })
    await stream.return(undefined)

    expect(await scope.spendLast24h()).toBeCloseTo(0.25, 6)
  })
})

// --- audit log -------------------------------------------------------------

describe('the audit log', () => {
  it('records key actions', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'dev@acme.test')
    await upload(owner, [{ path: 'a.txt', content: 'hello world', acl: ['public-to-org'] }])
    await askEvents(owner, 'hello world')

    const entries = body<Array<{ action: string }>>(
      await app().inject({ method: 'GET', url: '/audit', headers: auth(owner) }),
    )
    const actions = new Set(entries.map((e) => e.action))
    for (const expected of ['org.created', 'member.added', 'source.synced', 'question.asked']) {
      expect(actions, expected).toContain(expected)
    }
  })

  it('is admin only', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'dev@acme.test')
    const dev = await login('dev@acme.test', 'acme')
    const res = await app().inject({ method: 'GET', url: '/audit', headers: auth(dev) })
    expect(res.statusCode).toBe(403)
  })
})
