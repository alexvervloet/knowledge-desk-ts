/**
 * Phase 4: the assistant. A grounded answer streams with access-scoped sources;
 * when nothing the caller may see matches, it refuses instead of answering from
 * the model. Feedback attaches to a recorded answer, one per user, org-scoped.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect } from '../src/db.ts'
import { runPending } from '../src/ingest.ts'
import * as providers from '../src/providers.ts'
import { MOCK_BANNER, type Context, type ProviderEvent } from '../src/providers.ts'
import { auth, body, signup as signupOrg, sseEvents, useApp, useCleanDb } from './helpers.ts'

const app = useApp()
useCleanDb()
afterEach(() => {
  vi.restoreAllMocks()
})

const PW = 'pw-supersecret'
const SECRET = 'The vault combination is seven-lion-north.'

type Event = Record<string, unknown>

async function signup(slug: string, email: string): Promise<string> {
  return (await signupOrg(app(), slug, email, PW)).token
}

async function addMember(owner: string, email: string): Promise<string> {
  const res = await app().inject({
    method: 'POST',
    url: '/members',
    headers: auth(owner),
    payload: { email, password: PW, role: 'member' },
  })
  expect(res.statusCode).toBe(201)
  return body<{ user_id: string }>(res).user_id
}

async function login(email: string, slug: string): Promise<string> {
  const res = await app().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PW, org_slug: slug },
  })
  return body<{ token: string }>(res).token
}

async function upload(
  token: string,
  documents: Array<{ path: string; content: string; acl?: string[] }>,
): Promise<void> {
  const res = await app().inject({
    method: 'POST',
    url: '/sources/folder',
    headers: auth(token),
    payload: { documents },
  })
  expect(res.statusCode).toBe(202)
  await runPending()
}

async function ask(token: string, question: string, k?: number): Promise<Event[]> {
  const res = await app().inject({
    method: 'POST',
    url: '/ask',
    headers: auth(token),
    payload: k === undefined ? { question } : { question, k },
  })
  expect(res.statusCode).toBe(200)
  return sseEvents(res.body)
}

function tokens(events: Event[]): string {
  return events
    .filter((e) => e.type === 'token')
    .map((e) => String(e.text))
    .join('')
}

function byType(events: Event[], t: string): Event[] {
  return events.filter((e) => e.type === t)
}

async function answerIdFor(token: string, question: string): Promise<string> {
  return String(byType(await ask(token, question), 'meta')[0]?.answer_id)
}

// --- grounded answer ------------------------------------------------------

it('streams meta, sources, tokens, then done for a grounded answer', async () => {
  const token = await signup('acme', 'o@acme.test')
  await upload(token, [{ path: 'vault.txt', content: SECRET, acl: ['public-to-org'] }])
  const events = await ask(token, SECRET)

  const meta = byType(events, 'meta')[0]
  expect(meta?.provider).toBe('mock')
  expect(meta?.answer_id).toBeTruthy()
  const sources = byType(events, 'sources')[0]?.sources as Array<{ path: string }>
  expect(sources.some((s) => s.path === 'vault.txt')).toBe(true)
  expect(tokens(events)).toContain(MOCK_BANNER)
  const done = byType(events, 'done')[0]?.usage as Record<string, unknown>
  expect(done).toHaveProperty('input_tokens')
  expect(done).toHaveProperty('output_tokens')
})

// --- refusal carries the permission boundary through -----------------------

describe('refusal', () => {
  it('refuses when the org has no documents', async () => {
    const token = await signup('acme', 'o@acme.test')
    const events = await ask(token, 'what is the vault combination?')
    expect(byType(events, 'sources')).toEqual([]) // nothing to cite
    expect(tokens(events).toLowerCase()).toContain("don't have anything")
  })

  it('refuses when the context is not permitted', async () => {
    const owner = await signup('acme', 'o@acme.test')
    const xId = await addMember(owner, 'x@acme.test')
    await addMember(owner, 'y@acme.test')
    await upload(owner, [{ path: 'secret.txt', content: SECRET, acl: [`user:${xId}`] }])

    // X can ground an answer on it; Y gets a refusal with no sources.
    const xEvents = await ask(await login('x@acme.test', 'acme'), SECRET)
    const xSources = byType(xEvents, 'sources')[0]?.sources as Array<{ path: string }>
    expect(xSources.some((s) => s.path === 'secret.txt')).toBe(true)

    const yEvents = await ask(await login('y@acme.test', 'acme'), SECRET)
    expect(byType(yEvents, 'sources')).toEqual([])
    expect(tokens(yEvents)).not.toContain('seven-lion-north')
  })
})

// --- validation and recording ---------------------------------------------

describe('validation and recording', () => {
  const post = (token: string, payload: unknown) =>
    app().inject({ method: 'POST', url: '/ask', headers: auth(token), payload })

  it('rejects empty and overlong questions with 422', async () => {
    const token = await signup('acme', 'o@acme.test')
    expect((await post(token, { question: '' })).statusCode).toBe(422)
    expect((await post(token, { question: 'x'.repeat(501) })).statusCode).toBe(422)
  })

  it('records the answer as refused when there is no context', async () => {
    const token = await signup('acme', 'o@acme.test')
    const answerId = String(byType(await ask(token, 'anything?'), 'meta')[0]?.answer_id)
    const orgId = body<{ org_id: string }>(
      await app().inject({ method: 'GET', url: '/me', headers: auth(token) }),
    ).org_id
    // RLS: reads need the org context set.
    const row = await connect(orgId, (conn) =>
      conn.require<{ refused: boolean }>('select refused from answers where id = $1', [answerId]),
    )
    expect(row.refused).toBe(true)
  })
})

// --- failure handling ------------------------------------------------------

/**
 * The broad catch is right — a provider failure must not become a 500 in the
 * middle of a stream — but it used to put the exception message straight into the
 * frame the browser renders, so a database error handed the caller its host name
 * and the role it connected as.
 */
it('does not leak internals to the caller when the provider fails', async () => {
  const leaky =
    "connection to db-internal-7.prod failed: password authentication failed for user 'kd_app'"

  const token = await signup('acme', 'o@acme.test')
  await upload(token, [{ path: 'd.txt', content: SECRET, acl: ['public-to-org'] }])

  const logged: unknown[][] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args)
  })
  vi.spyOn(providers, 'getAnswerProvider').mockReturnValue({
    name: 'claude',
    estimate: () => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    // eslint-disable-next-line require-yield
    stream: async function* (): AsyncGenerator<ProviderEvent, void, undefined> {
      throw new Error(leaky)
    },
  })

  const events = await ask(token, SECRET)
  const message = String(events.find((e) => e.type === 'error')?.message)

  expect(message).not.toContain('db-internal-7.prod')
  expect(message).not.toContain('kd_app')
  // The caller gets a handle that ties their report to the logged detail.
  const reference = message.split('reference ')[1]?.split(/\s/)[0] ?? ''
  expect(reference).not.toBe('')
  const text = logged.map((args) => args.map(String).join(' ')).join('\n')
  expect(text).toContain(reference)
  expect(text).toContain(leaky)
})

// --- feedback -------------------------------------------------------------

describe('feedback', () => {
  const leave = (token: string, payload: unknown) =>
    app().inject({ method: 'POST', url: '/feedback', headers: auth(token), payload })

  it('records once per user', async () => {
    const token = await signup('acme', 'o@acme.test')
    const aid = await answerIdFor(token, 'hello?')
    expect((await leave(token, { answer_id: aid, rating: 'up' })).statusCode).toBe(201)
    // A second rating for the same answer by the same user conflicts.
    expect((await leave(token, { answer_id: aid, rating: 'down' })).statusCode).toBe(409)
  })

  it('validates the rating', async () => {
    const token = await signup('acme', 'o@acme.test')
    const aid = await answerIdFor(token, 'hello?')
    expect((await leave(token, { answer_id: aid, rating: 'meh' })).statusCode).toBe(422)
  })

  it('answers 404 for a foreign answer', async () => {
    const a = await signup('acme', 'o@acme.test')
    const b = await signup('globex', 'o@globex.test')
    const bAnswer = await answerIdFor(b, 'hello?')
    // Org A cannot leave feedback on org B's answer.
    expect((await leave(a, { answer_id: bAnswer, rating: 'up' })).statusCode).toBe(404)
  })
})

// --- output checks ---------------------------------------------------------

describe('output checks', () => {
  /**
   * The checks run on the finished answer and ride out in the done frame. The
   * mock provider always cites [1], so a single retrieved passage keeps it in
   * range; the flagged case needs an answer the checks object to.
   */
  it('carries warnings in the done frame', async () => {
    const token = await signup('acme', 'owner@acme.test')
    await upload(token, [{ path: 'policy.txt', content: 'refunds take five days' }])
    const events = await ask(token, 'how long do refunds take')
    const done = events.find((e) => e.type === 'done')
    expect(done?.warnings).toEqual([])
  })

  /**
   * A single flagged answer is noise. The point of writing it down is that a
   * pattern across many of them is not, and nothing else here would show it.
   */
  it('records a flagged answer in the audit log', async () => {
    vi.spyOn(providers, 'getAnswerProvider').mockReturnValue({
      name: 'mock',
      estimate: () => ({ inputTokens: 1, outputTokens: 1, costUsd: 0.0 }),
      stream: async function* (
        _question: string,
        _contexts: Context[],
      ): AsyncGenerator<ProviderEvent, void, undefined> {
        yield { type: 'token', text: 'See [9] and <<<UNTRUSTED_DOCUMENT 00>>>.' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0.0 }
      },
    })

    const token = await signup('acme', 'owner@acme.test')
    await upload(token, [{ path: 'policy.txt', content: 'refunds take five days' }])
    const done = (await ask(token, 'refunds')).find((e) => e.type === 'done')

    const warnings = done?.warnings as Array<{ code: string }>
    expect(new Set(warnings.map((w) => w.code))).toEqual(
      new Set(['citation_out_of_range', 'fence_echoed']),
    )

    const audit = body<Array<{ action: string }>>(
      await app().inject({ method: 'GET', url: '/audit', headers: auth(token) }),
    )
    expect(audit.map((r) => r.action)).toContain('answer.flagged')
  })
})
