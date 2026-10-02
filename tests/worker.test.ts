/**
 * The in-process drain: it runs what is due, waits out a retry, and stops when
 * the queue is empty, which is what lets an idle deployment send no queries.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as accounts from '../src/accounts.ts'
import { settings } from '../src/config.ts'
import { connect } from '../src/db.ts'
import { DISPATCH } from '../src/ingest.ts'
import * as jobs from '../src/jobs.ts'
import { drain, kick } from '../src/worker.ts'
import { auth, body, signup, useApp, useCleanDb } from './helpers.ts'

useCleanDb()
const app = useApp()

afterEach(() => {
  delete DISPATCH.noop
  settings.drainInProcess = false
})

async function org(): Promise<string> {
  return (await accounts.createOrgWithOwner('acme', 'Acme', 'o@acme.test', 'pw-supersecret')).orgId
}

async function statuses(): Promise<string[]> {
  const rows = await connect(null, (conn) =>
    conn.query<{ status: string }>('select status from jobs order by created_at'),
  )
  return rows.map((r) => r.status)
}

/** A `noop` job kind that records each run. */
function recordRuns(): Record<string, unknown>[] {
  const calls: Record<string, unknown>[] = []
  DISPATCH.noop = async (_org, payload) => {
    calls.push(payload)
  }
  return calls
}

describe('drain', () => {
  it('runs due jobs, then returns', async () => {
    const calls = recordRuns()
    const orgId = await org()
    await jobs.enqueue(orgId, 'noop', { i: 1 }, 'k1')
    await jobs.enqueue(orgId, 'noop', { i: 2 }, 'k2')
    await drain()
    expect(calls.map((c) => c.i)).toEqual([1, 2])
    expect(await statuses()).toEqual(['succeeded', 'succeeded'])
  })

  it('waits out a retry', async () => {
    let attempts = 0
    DISPATCH.noop = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
    }
    await jobs.enqueue(await org(), 'noop', {}, 'k')
    await drain() // first attempt fails, backoff is 2s, then it succeeds
    expect(attempts).toBe(2)
    expect(await statuses()).toEqual(['succeeded'])
  })
})

describe('kick', () => {
  it('drains in the background and stops when the queue is empty', async () => {
    recordRuns()
    settings.drainInProcess = true
    await jobs.enqueue(await org(), 'noop', {}, 'k')
    const running = kick()
    expect(running).not.toBeNull()
    await running
    expect(await statuses()).toEqual(['succeeded'])
    // Stopped, so the next kick starts a fresh drain rather than joining one.
    const next = kick()
    expect(next).not.toBe(running)
    await next
  })

  it('does nothing when draining in-process is off', async () => {
    recordRuns()
    await jobs.enqueue(await org(), 'noop', {}, 'k')
    expect(kick()).toBeNull()
    expect(await statuses()).toEqual(['queued'])
  })

  it('ingests an upload with no runPending call', async () => {
    settings.drainInProcess = true
    const { token } = await signup(app())
    const res = await app().inject({
      method: 'POST',
      url: '/sources/folder',
      headers: auth(token),
      payload: { documents: [{ path: 'a.txt', content: 'refunds take five days' }] },
    })
    expect(res.statusCode).toBe(202)
    await kick() // joins the drain the upload started, or finds it already done
    const docs = await app().inject({ method: 'GET', url: '/documents', headers: auth(token) })
    expect(body<{ status: string }[]>(docs).map((d) => d.status)).toEqual(['ingested'])
  })
})
