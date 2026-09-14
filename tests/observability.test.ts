/**
 * Phase 9 observability: the tracer is inert without keys and never breaks a
 * request, and retrievalStats exposes the ACL filter (org total vs what a caller
 * may see) that the retriever trace span reports.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as accounts from '../src/accounts.ts'
import * as ingest from '../src/ingest.ts'
import { TenantScope } from '../src/tenancy.ts'
import { AskTracer, setStartObservation } from '../src/tracing.ts'
import { auth, body, useApp, useCleanDb } from './helpers.ts'

const app = useApp()
useCleanDb()

const PW = 'pw-supersecret'

afterEach(() => {
  setStartObservation(null)
})

it('is inert without keys', () => {
  // Every method must be a safe no-op when Langfuse is not configured.
  const t = new AskTracer('q', 'org', 'user', 'mock', 'mock')
  expect(t.active).toBe(false)
  t.sources([{ document_id: 'd', ordinal: 0, path: 'a' }], { orgChunks: 3, allowedChunks: 1 })
  t.token('hello ')
  t.done(1, 2, 0.0)
  t.finish() // no throw
})

// --- the active path ------------------------------------------------------
//
// Prove it calls the SDK correctly, without a real Langfuse.

interface Recorded {
  name: string
  attributes: Record<string, unknown>
  asType: string | undefined
  updates: Array<Record<string, unknown>>
  children: Recorded[]
  ended: boolean
  traceIO: Record<string, unknown>
}

function fakeObservation(name: string, attributes: Record<string, unknown> = {}, asType?: string) {
  const record: Recorded = {
    name,
    attributes,
    asType,
    updates: [],
    children: [],
    ended: false,
    traceIO: {},
  }
  const self = {
    record,
    startObservation(
      childName: string,
      childAttributes: Record<string, unknown> = {},
      options?: { asType?: string },
    ) {
      const child = fakeObservation(childName, childAttributes, options?.asType)
      record.children.push(child.record)
      return child
    },
    update(kwargs: Record<string, unknown>) {
      record.updates.push(kwargs)
      return self
    },
    end() {
      record.ended = true
    },
    setTraceIO(io: Record<string, unknown>) {
      record.traceIO = io
    },
  }
  return self
}

/** Install the fake and hand back the root record once the tracer opens one. */
function captureRoot(): () => Recorded {
  let root: Recorded | undefined
  setStartObservation(((name: string, attributes: Record<string, unknown>) => {
    const obs = fakeObservation(name, attributes)
    root = obs.record
    return obs
    // The seam is typed against the SDK's span; the fake implements the four
    // methods this module actually calls.
  }) as never)
  return () => {
    if (root === undefined) throw new Error('the active tracer must have opened a root observation')
    return root
  }
}

describe('the active path', () => {
  it('records spans when enabled', () => {
    const root = captureRoot()

    const t = new AskTracer('what is x?', 'org-1', 'user-1', 'claude', 'claude-opus-5')
    expect(t.active).toBe(true)
    t.sources([{ document_id: 'd', ordinal: 0, path: 'a.txt' }], {
      orgChunks: 5,
      allowedChunks: 2,
    })
    t.token('the answer ')
    t.done(100, 20, 0.0012)
    t.finish()

    const r = root()
    expect(r.name).toBe('ask')
    expect((r.attributes.metadata as Record<string, unknown>).org_id).toBe('org-1')
    const [retrieval, generation] = r.children // retriever then generation
    expect(retrieval?.asType).toBe('retriever')
    expect(retrieval?.ended).toBe(true)
    expect((retrieval?.updates[0]?.output as Record<string, unknown>).acl).toEqual({
      orgChunks: 5,
      allowedChunks: 2,
    })
    expect(generation?.asType).toBe('generation')
    expect(generation?.updates[0]?.usageDetails).toEqual({ input: 100, output: 20 })
    expect(generation?.updates[0]?.costDetails).toEqual({ total: 0.0012 })
    expect(r.traceIO.output).toBe('the answer ')
    expect(r.ended).toBe(true)
  })

  /**
   * The question and answer are stored unredacted in Postgres deliberately.
   * Langfuse is a third party, so the same text is redacted on the way there.
   */
  it('redacts PII before it leaves for Langfuse', () => {
    const root = captureRoot()

    const t = new AskTracer('what did dana@acme.test file?', 'org-1', 'user-1', 'claude', 'm')
    t.sources([{ document_id: 'd', ordinal: 0, path: 'hr/dana@acme.test-review.txt' }], null)
    t.token('her SSN is ')
    t.token('123-45-6789')
    t.done(10, 5, 0.001)
    t.finish()

    const r = root()
    const [retrieval, generation] = r.children
    expect(String(r.attributes.input)).not.toContain('dana@acme.test')
    expect(String(r.attributes.input)).toContain('[REDACTED-EMAIL]')
    expect(JSON.stringify(retrieval?.updates[0]?.output)).not.toContain('dana@acme.test')
    expect(String(generation?.updates[0]?.output)).not.toContain('123-45-6789')
    expect(String(generation?.updates[0]?.output)).toContain('[REDACTED-SSN]')
    expect(JSON.stringify(r.traceIO)).not.toContain('123-45-6789')
  })

  /**
   * userId already ties a trace to a person. The address is the one field here
   * that identifies one on its own, so it does not go.
   */
  it('does not send the user’s email address', () => {
    const root = captureRoot()
    new AskTracer('q', 'org-1', 'user-1', 'claude', 'm').finish()
    expect(root().attributes.metadata).not.toHaveProperty('email')
  })

  /**
   * Redaction happens at the join. Per token, "123-45-" and "6789" each look
   * harmless, and the pattern only exists once they are back together.
   */
  it('redacts a streamed secret split across tokens', () => {
    const root = captureRoot()

    const t = new AskTracer('q', 'org-1', 'user-1', 'claude', 'm')
    t.sources([], null)
    for (const piece of ['123', '-45', '-6789']) t.token(piece)
    t.done(1, 1, 0.0)

    expect(root().children[1]?.updates[0]?.output).toBe('[REDACTED-SSN]')
  })
})

// --- the request path ------------------------------------------------------

it('still streams an answer with the tracing path in place', async () => {
  const token = body<{ token: string }>(
    await app().inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { org_slug: 'acme', org_name: 'Acme', email: 'o@acme.test', password: PW },
    }),
  ).token
  await app().inject({
    method: 'POST',
    url: '/sources/folder',
    headers: auth(token),
    payload: {
      documents: [
        { path: 'a.txt', content: 'refunds take five business days', acl: ['public-to-org'] },
      ],
    },
  })
  await ingest.runPending()
  const res = await app().inject({
    method: 'POST',
    url: '/ask',
    headers: auth(token),
    payload: { question: 'refunds take five business days' },
  })
  expect(res.statusCode).toBe(200)
  expect(res.body).toContain('"type":"done"')
  expect(res.body).toContain('"type":"sources"')
})

it('exposes the ACL filter in retrievalStats', async () => {
  const owner = await accounts.createOrgWithOwner('acme', 'Acme', 'o@acme.test', PW)
  const xId = await accounts.addMember(owner.orgId, 'x@acme.test', PW, 'member')
  await accounts.addMember(owner.orgId, 'y@acme.test', PW, 'member')
  await ingest.syncDocuments(owner.orgId, 'local-folder', [
    { path: 'public.txt', content: 'everyone can read this', acl: ['public-to-org'] },
    { path: 'secret.txt', content: 'only x can read this', acl: [`user:${xId}`] },
  ])
  await ingest.runPending()

  const x = new TenantScope(await accounts.authenticate('x@acme.test', PW, 'acme'))
  const y = new TenantScope(await accounts.authenticate('y@acme.test', PW, 'acme'))

  const xs = await x.retrievalStats()
  const ys = await y.retrievalStats()
  expect(xs.orgChunks).toBe(2) // both documents, one chunk each
  expect(xs.allowedChunks).toBe(2) // X sees the public and its own secret
  expect(ys.orgChunks).toBe(2)
  expect(ys.allowedChunks).toBe(1) // Y sees only the public document
})
