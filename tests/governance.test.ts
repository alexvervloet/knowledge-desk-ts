/**
 * Phase 6 governance: PII flagging at ingest, document/tenant deletion and
 * export, and proof that row-level security blocks a query that lacks org
 * context.
 */

import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect, getPool } from '../src/db.ts'
import { runPending } from '../src/ingest.ts'
import { sweepPages } from '../src/tenancy.ts'
import { auth, body, signup as signupOrg, useApp, useCleanDb } from './helpers.ts'

const app = useApp()
useCleanDb()
afterEach(() => {
  vi.restoreAllMocks()
})

const PW = 'pw-supersecret'

interface DocRow {
  id: string
  path: string
  pii_types: string[]
}

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

function post(token: string, url: string, payload: object) {
  return app().inject({ method: 'POST', url, headers: auth(token), payload })
}

async function upload(
  token: string,
  documents: Array<{ path: string; content: string; acl?: string[] }>,
): Promise<void> {
  expect((await post(token, '/sources/folder', { documents })).statusCode).toBe(202)
  await runPending()
}

async function docsByPath(token: string): Promise<Record<string, DocRow>> {
  const rows = body<DocRow[]>(
    await app().inject({ method: 'GET', url: '/documents', headers: auth(token) }),
  )
  return Object.fromEntries(rows.map((d) => [d.path, d]))
}

async function orgOf(token: string): Promise<string> {
  return body<{ org_id: string }>(
    await app().inject({ method: 'GET', url: '/me', headers: auth(token) }),
  ).org_id
}

async function countDocuments(orgId: string | null): Promise<number> {
  const row = await connect(orgId, (conn) =>
    conn.require<{ n: string }>('select count(*) as n from documents'),
  )
  return Number(row.n)
}

// --- PII flagging ----------------------------------------------------------

it('flags PII at ingest', async () => {
  const token = await signup('acme', 'o@acme.test')
  await upload(token, [
    {
      path: 'hr.txt',
      content: 'Reach Jane at jane@acme.test or SSN 123-45-6789.',
      acl: ['public-to-org'],
    },
    { path: 'clean.txt', content: 'The weather is nice today.', acl: ['public-to-org'] },
  ])
  const docs = await docsByPath(token)
  expect(new Set(docs['hr.txt']?.pii_types)).toEqual(new Set(['email', 'ssn']))
  expect(docs['clean.txt']?.pii_types).toEqual([])
})

// --- document deletion -----------------------------------------------------

describe('document deletion', () => {
  it('removes the document and its chunks', async () => {
    const token = await signup('acme', 'o@acme.test')
    await upload(token, [
      { path: 'a.txt', content: 'alpha content here', acl: ['public-to-org'] },
    ])
    const docId = (await docsByPath(token))['a.txt']!.id

    const deleted = await app().inject({
      method: 'DELETE',
      url: `/documents/${docId}`,
      headers: auth(token),
    })
    expect(deleted.statusCode).toBe(204)
    expect(await docsByPath(token)).toEqual({})
    // Its chunks are gone too, so retrieval no longer surfaces it.
    expect(body(await post(token, '/search', { query: 'alpha content here' }))).toEqual([])
  })

  it('requires admin', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'dev@acme.test')
    await upload(owner, [{ path: 'a.txt', content: 'alpha', acl: ['public-to-org'] }])
    const docId = (await docsByPath(owner))['a.txt']!.id
    const dev = await login('dev@acme.test', 'acme')
    const res = await app().inject({
      method: 'DELETE',
      url: `/documents/${docId}`,
      headers: auth(dev),
    })
    expect(res.statusCode).toBe(403)
  })

  it('answers 404 for an unknown document', async () => {
    const token = await signup('acme', 'o@acme.test')
    const res = await app().inject({
      method: 'DELETE',
      url: `/documents/${randomUUID()}`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(404)
  })
})

// --- tenant export and deletion --------------------------------------------

describe('export', () => {
  const exportOrg = (token: string) =>
    app().inject({ method: 'GET', url: '/org/export', headers: auth(token) })

  it('returns members and documents', async () => {
    const token = await signup('acme', 'o@acme.test')
    await upload(token, [{ path: 'a.txt', content: 'hello', acl: ['public-to-org'] }])
    const data = body<{ members: Array<{ email: string }>; documents: DocRow[] }>(
      await exportOrg(token),
    )
    expect(data.members.some((m) => m.email === 'o@acme.test')).toBe(true)
    expect(data.documents.some((d) => d.path === 'a.txt')).toBe(true)
  })

  /**
   * The export must not inherit the listings' pagination default.
   *
   * export() used to call listDocuments() bare, so a tenant with more than 100
   * documents got a well-formed export containing 100 of them and no indication
   * that the rest were missing.
   */
  it('is complete past the default page size', async () => {
    const token = await signup('acme', 'o@acme.test')
    // Enqueued, not drained: the export lists documents whatever their status,
    // and embedding 120 of them would only make the test slow.
    const paths = Array.from({ length: 120 }, (_, i) => `doc${String(i).padStart(3, '0')}.txt`)
    await post(token, '/sources/folder', {
      documents: paths.map((p) => ({ path: p, content: p })),
    })

    const data = body<{ documents: DocRow[] }>(await exportOrg(token))
    expect(new Set(data.documents.map((d) => d.path))).toEqual(new Set(paths))
  })

  it('requires admin', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'dev@acme.test')
    const dev = await login('dev@acme.test', 'acme')
    expect((await exportOrg(dev)).statusCode).toBe(403)
  })
})

/**
 * The sweep loop on its own. The property worth testing is that it terminates on
 * a row count which is an exact multiple of the page size — the off-by-one that
 * would otherwise drop the final page or spin forever — and a tenant with 500
 * documents would be too slow to make that assertion through the API.
 */
describe('sweepPages', () => {
  /** A listing of `total` rows, served `limit` at a time, counting its calls. */
  function paged(total: number): {
    fetch: (limit: number, offset: number) => Promise<number[]>
    calls: () => number
  } {
    const all = Array.from({ length: total }, (_, i) => i)
    let calls = 0
    return {
      fetch: (limit, offset) => {
        calls += 1
        return Promise.resolve(all.slice(offset, offset + limit))
      },
      calls: () => calls,
    }
  }

  it.each([
    [0, 1],
    [1, 1],
    [3, 2],
    [4, 3], // an exact multiple: needs the extra empty page to know it is done
    [5, 3],
    [8, 5], // an exact multiple again, two pages further out
  ])('collects %i rows in %i fetches at page size 2', async (total, expectedCalls) => {
    const { fetch, calls } = paged(total)
    const rows = await sweepPages(fetch, 2)
    expect(rows).toHaveLength(total)
    expect(rows).toEqual(Array.from({ length: total }, (_, i) => i))
    expect(calls(), 'a short page is what ends the loop').toBe(expectedCalls)
  })
})

describe('tenant deletion', () => {
  const deleteOrg = (token: string) =>
    app().inject({ method: 'DELETE', url: '/org', headers: auth(token) })
  const me = (token: string) =>
    app().inject({ method: 'GET', url: '/me', headers: auth(token) })

  it('is owner only and cascades', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'dev@acme.test')
    const dev = await login('dev@acme.test', 'acme')
    // A member cannot delete the tenant.
    expect((await deleteOrg(dev)).statusCode).toBe(403)
    // The owner can; afterward the session no longer resolves (cascade removed it).
    expect((await deleteOrg(owner)).statusCode).toBe(204)
    expect((await me(owner)).statusCode).toBe(401)
  })

  /**
   * A tenant delete used to leave the owner's user row behind. It had no
   * memberships, so nobody could log into it, and its email was refused for every
   * future signup. The address was burned by deleting the org that owned it.
   */
  it('releases the owner email', async () => {
    const owner = await signup('acme', 'o@acme.test')
    expect((await deleteOrg(owner)).statusCode).toBe(204)

    const again = await app().inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { org_slug: 'acme2', org_name: 'Acme 2', email: 'o@acme.test', password: PW },
    })
    expect(again.statusCode).toBe(201)
  })

  /**
   * The reason users are not org-scoped in the first place. Deleting one tenant
   * must not touch an account that is still in use somewhere else.
   */
  it('keeps a member who belongs to another org', async () => {
    const acme = await signup('acme', 'o@acme.test')
    const globex = await signup('globex', 'o@globex.test')
    await addMember(acme, 'shared@x.test')
    // The same person in a second org, which today means a second account.
    await addMember(globex, 'shared2@x.test')

    expect((await deleteOrg(acme)).statusCode).toBe(204)

    const stillThere = await login('shared2@x.test', 'globex')
    expect((await me(stillThere)).statusCode).toBe(200)
  })
})

describe('member removal', () => {
  /**
   * The same defect on the other path: removeMember deletes the membership and
   * used to leave the user.
   */
  it('releases the email when it was their only org', async () => {
    const owner = await signup('acme', 'o@acme.test')
    const userId = await addMember(owner, 'dev@acme.test')

    const removed = await app().inject({
      method: 'DELETE',
      url: `/members/${userId}`,
      headers: auth(owner),
    })
    expect(removed.statusCode).toBe(204)

    const readded = await post(owner, '/members', {
      email: 'dev@acme.test',
      password: PW,
      role: 'member',
    })
    expect(readded.statusCode).toBe(201)
  })

  /**
   * Deleting the row also invalidates the credential, which is the point of
   * removing someone.
   */
  it('stops the old password working', async () => {
    const owner = await signup('acme', 'o@acme.test')
    const userId = await addMember(owner, 'dev@acme.test')
    await app().inject({ method: 'DELETE', url: `/members/${userId}`, headers: auth(owner) })

    const res = await app().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'dev@acme.test', password: PW, org_slug: 'acme' },
    })
    expect(res.statusCode).toBe(401)
  })
})

// --- row-level security ----------------------------------------------------

describe('row-level security', () => {
  /**
   * The pooling landmine: the tenant GUC must be transaction-scoped. If it were
   * session-scoped it would survive the commit, ride the connection back into the
   * pool, and hand the next borrower the previous tenant's context. Borrowing
   * repeatedly until the same connection is reused proves it does not.
   */
  it('does not let a pooled connection inherit the previous tenant', async () => {
    const a = await signup('acme', 'o@acme.test')
    await upload(a, [
      { path: 'acme-only.txt', content: 'acme confidential data', acl: ['public-to-org'] },
    ])
    const orgA = await orgOf(a)

    const seen = new Set<unknown>()
    for (let i = 0; i < 5; i++) {
      // A scoped borrow, exactly as a request would do.
      await connect(orgA, async (conn) => {
        seen.add(conn)
        expect(Number((await conn.require<{ n: string }>('select count(*) as n from documents')).n)).toBe(1)
      })
      // An unscoped borrow: whatever connection this gets, it must see nothing.
      await connect(null, async (conn) => {
        seen.add(conn)
        expect(Number((await conn.require<{ n: string }>('select count(*) as n from documents')).n)).toBe(0)
      })
    }

    // Python asserts on connection object identity. `connect` here wraps every
    // checkout in a fresh Conn, so identity says nothing; the pool's own count of
    // physical connections is what proves reuse. Ten sequential borrows opened
    // one socket, so every assertion above ran against a reused connection —
    // which is the only arrangement in which this test means anything.
    expect(seen.size, 'ten borrows, ten wrappers').toBe(10)
    expect(getPool().totalCount, 'ten borrows should reuse one physical connection').toBe(1)
  })

  it('blocks a query with no org context', async () => {
    const token = await signup('acme', 'o@acme.test')
    await upload(token, [{ path: 'a.txt', content: 'hello world', acl: ['public-to-org'] }])
    const orgId = await orgOf(token)

    // As the app role with no org GUC set, RLS returns zero rows even though the
    // document exists; with the org context set, it is visible.
    expect(await countDocuments(null)).toBe(0)
    expect(await countDocuments(orgId)).toBe(1)
  })
})
