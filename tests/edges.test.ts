/**
 * The paths that only run when something is misconfigured or going wrong.
 *
 * Each of these is a branch the main suites never reach, and each one is a
 * property somebody relied on when they wrote the module: the Voyage client
 * reorders its results, an audit failure does not take the request with it, and
 * the rate limiter reads the proxy's header rather than the proxy's address.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as audit from '../src/audit.ts'
import { settings } from '../src/config.ts'
import * as db from '../src/db.ts'
import { clientKey } from '../src/deps.ts'
import { MockEmbedder, VoyageEmbedder, getEmbedder } from '../src/embeddings.ts'
import { isUniqueViolation } from '../src/db.ts'
import { round6 } from '../src/numbers.ts'
import type { FastifyRequest } from 'fastify'

const { provider: _derived, ...ORIGINAL } = settings
afterEach(() => {
  Object.assign(settings, ORIGINAL)
  vi.restoreAllMocks()
})

// --- the Voyage embedder ---------------------------------------------------

describe('the Voyage embedder', () => {
  function respondWith(payload: unknown, ok = true, status = 200): void {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
    } as Response)
  }

  /**
   * The API does not promise results come back in request order. Out of order
   * and unsorted, every chunk gets another chunk's vector — a total retrieval
   * failure with nothing in the logs to say so.
   */
  it('reorders results by index', async () => {
    settings.voyageApiKey = 'test-key'
    respondWith({
      data: [
        { index: 2, embedding: [3] },
        { index: 0, embedding: [1] },
        { index: 1, embedding: [2] },
      ],
    })
    const vectors = await new VoyageEmbedder().embedDocuments(['a', 'b', 'c'])
    expect(vectors).toEqual([[1], [2], [3]])
  })

  it('refuses a response with the wrong number of embeddings', async () => {
    settings.voyageApiKey = 'test-key'
    respondWith({ data: [{ index: 0, embedding: [1] }] })
    await expect(new VoyageEmbedder().embedDocuments(['a', 'b'])).rejects.toThrow(
      /1 embeddings for 2 inputs/,
    )
  })

  /**
   * An error body served with a 200, or a changed response shape, would
   * otherwise surface as "undefined is not iterable" somewhere in the worker.
   */
  it('refuses a response that is not the documented shape', async () => {
    settings.voyageApiKey = 'test-key'
    respondWith({ error: 'quota exceeded' })
    await expect(new VoyageEmbedder().embedQuery('a')).rejects.toThrow(/no data array/)

    respondWith({ data: [{ nope: true }] })
    await expect(new VoyageEmbedder().embedQuery('a')).rejects.toThrow(/embedding, index/)
  })

  it('surfaces a non-200 with its status', async () => {
    settings.voyageApiKey = 'test-key'
    respondWith({ detail: 'unauthorized' }, false, 401)
    await expect(new VoyageEmbedder().embedQuery('a')).rejects.toThrow(/401/)
  })

  it('needs a key to construct', () => {
    settings.voyageApiKey = undefined
    expect(() => new VoyageEmbedder()).toThrow(/VOYAGE_API_KEY/)
  })

  it('is what getEmbedder picks when a key is set', () => {
    settings.voyageApiKey = undefined
    expect(getEmbedder()).toBeInstanceOf(MockEmbedder)
    settings.voyageApiKey = 'test-key'
    expect(getEmbedder()).toBeInstanceOf(VoyageEmbedder)
  })
})

// --- the audit log's failure path ------------------------------------------

/**
 * Audit writes are best-effort on purpose: losing the ability to record an event
 * must not take down the action the user was performing. The trade-off is a gap
 * in the log rather than a failed request, and this is the test that says the
 * trade-off is the one actually implemented.
 */
it('does not propagate an audit failure', async () => {
  const logged: string[] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  })
  vi.spyOn(db, 'connect').mockRejectedValue(new Error('database is on fire'))

  await expect(audit.log('org-1', 'user-1', 'thing.happened', { a: 1 })).resolves.toBeUndefined()
  expect(logged.join('\n')).toContain('failed to record thing.happened')
  expect(logged.join('\n')).toContain('database is on fire')
})

// --- identifying a caller behind a proxy -----------------------------------

describe('clientKey', () => {
  const request = (ip: string, headers: Record<string, string> = {}) =>
    ({ ip, headers }) as unknown as FastifyRequest

  it('uses the socket peer when no header is configured', () => {
    settings.clientIpHeader = undefined
    expect(clientKey(request('203.0.113.7'))).toBe('203.0.113.7')
  })

  /**
   * Behind a proxy the socket peer is the proxy, so every caller would share one
   * bucket and the limiter would throttle the whole world together.
   */
  it('prefers the configured header when it is set', () => {
    settings.clientIpHeader = 'Fly-Client-IP'
    expect(clientKey(request('10.0.0.1', { 'fly-client-ip': '203.0.113.7' }))).toBe('203.0.113.7')
  })

  /** A forwarding chain names the original client first. */
  it('takes the first entry of a comma-separated header', () => {
    settings.clientIpHeader = 'X-Forwarded-For'
    expect(clientKey(request('10.0.0.1', { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe(
      '203.0.113.7',
    )
  })

  it('falls back to the socket peer when the header is absent', () => {
    settings.clientIpHeader = 'Fly-Client-IP'
    expect(clientKey(request('10.0.0.1'))).toBe('10.0.0.1')
  })

  it('says unknown when there is nothing to go on', () => {
    settings.clientIpHeader = undefined
    expect(clientKey(request(''))).toBe('unknown')
  })
})

// --- small things other tests reach through -------------------------------

describe('isUniqueViolation', () => {
  it('recognises SQLSTATE 23505 and nothing else', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true)
    expect(isUniqueViolation(Object.assign(new Error('other'), { code: '23503' }))).toBe(false)
    expect(isUniqueViolation(new Error('no code'))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation('23505')).toBe(false)
  })
})

/**
 * Python's `round` breaks a tie to the even digit and `toFixed` does not, and
 * these numbers are summed into a budget. The half cases are the whole point.
 */
describe('round6', () => {
  it.each([
    [0.0000005, 0.0], // half, down to even
    [0.0000015, 0.000002], // half, up to even
    [0.0000004, 0.0],
    [0.0000006, 0.000001],
    [0.007, 0.007],
    [0, 0],
  ])('rounds %d to %d', (input, expected) => {
    expect(round6(input)).toBeCloseTo(expected, 9)
  })
})
