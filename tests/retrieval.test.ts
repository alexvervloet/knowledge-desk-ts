/**
 * Phase 3, the crux: retrieval must return only what the caller is allowed to
 * see. The load-bearing test seeds a secret one user owns and proves another user
 * can never retrieve it, for any query. Access is enforced in the candidate fetch,
 * so these guarantees hold structurally, not by ranking luck.
 */

import { describe, expect, it } from 'vitest'
import { connect } from '../src/db.ts'
import { runPending } from '../src/ingest.ts'
import { auth, body, signup as signupOrg, useApp, useCleanDb } from './helpers.ts'

const app = useApp()
useCleanDb()

const PW = 'pw-supersecret'
const SECRET = 'The launch code is orange-tiger-42.'

interface UploadDoc {
  path: string
  content: string
  acl?: string[]
}

async function signup(slug: string, email: string): Promise<string> {
  return (await signupOrg(app(), slug, email, PW)).token
}

async function addMember(owner: string, email: string, role = 'member'): Promise<string> {
  const res = await app().inject({
    method: 'POST',
    url: '/members',
    headers: auth(owner),
    payload: { email, password: PW, role },
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
  expect(res.statusCode).toBe(200)
  return body<{ token: string }>(res).token
}

async function upload(token: string, documents: UploadDoc[]): Promise<void> {
  const res = await app().inject({
    method: 'POST',
    url: '/sources/folder',
    headers: auth(token),
    payload: { documents },
  })
  expect(res.statusCode).toBe(202)
  await runPending()
}

async function found(token: string, query: string, k = 50): Promise<Set<string>> {
  const res = await app().inject({
    method: 'POST',
    url: '/search',
    headers: auth(token),
    payload: { query, k },
  })
  expect(res.statusCode).toBe(200)
  return new Set(body<Array<{ path: string }>>(res).map((r) => r.path))
}

async function createGroup(token: string, name: string): Promise<string> {
  const res = await app().inject({
    method: 'POST',
    url: '/groups',
    headers: auth(token),
    payload: { name },
  })
  return body<{ id: string }>(res).id
}

async function addToGroup(token: string, groupId: string, email: string): Promise<void> {
  await app().inject({
    method: 'POST',
    url: `/groups/${groupId}/members`,
    headers: auth(token),
    payload: { email },
  })
}

async function listDocuments(token: string) {
  return body<Array<{ id: string; path: string; acl: string[] }>>(
    await app().inject({ method: 'GET', url: '/documents', headers: auth(token) }),
  )
}

// --- the load-bearing leak test -------------------------------------------

describe('the leak test', () => {
  it('never leaks a user-scoped secret to another user', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    const xId = await addMember(owner, 'x@acme.test')
    await addMember(owner, 'y@acme.test')
    await upload(owner, [{ path: 'secret.txt', content: SECRET, acl: [`user:${xId}`] }])

    const x = await login('x@acme.test', 'acme')
    const y = await login('y@acme.test', 'acme')
    // X owns the ACL and can retrieve it; Y cannot, querying the exact content.
    expect(await found(x, SECRET)).toContain('secret.txt')
    expect(await found(y, SECRET)).not.toContain('secret.txt')
  })

  /**
   * The guarantee is structural, so even an unrelated query, or a direct
   * 'what is the secret' probe, can never surface the forbidden chunk.
   */
  it('keeps a forbidden document absent for any query', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    const xId = await addMember(owner, 'x@acme.test')
    await addMember(owner, 'y@acme.test')
    await upload(owner, [{ path: 'secret.txt', content: SECRET, acl: [`user:${xId}`] }])
    const y = await login('y@acme.test', 'acme')
    for (const probe of [SECRET, 'what is the launch code', 'orange tiger', 'unrelated text']) {
      expect(await found(y, probe), probe).not.toContain('secret.txt')
    }
  })
})

// --- public and group visibility ------------------------------------------

describe('visibility', () => {
  it('shows a public-to-org document to every member', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    await addMember(owner, 'y@acme.test')
    await upload(owner, [
      { path: 'handbook.txt', content: 'Company handbook for everyone.', acl: ['public-to-org'] },
    ])
    const y = await login('y@acme.test', 'acme')
    expect(await found(y, 'Company handbook for everyone.')).toContain('handbook.txt')
  })

  it('shows a group-scoped document only to group members', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    await addMember(owner, 'dev@acme.test')
    await addMember(owner, 'other@acme.test')
    const gid = await createGroup(owner, 'eng')
    await addToGroup(owner, gid, 'dev@acme.test')
    await upload(owner, [
      { path: 'eng.txt', content: 'Engineering runbook secret.', acl: [`group:${gid}`] },
    ])

    const dev = await login('dev@acme.test', 'acme')
    const other = await login('other@acme.test', 'acme')
    expect(await found(dev, 'Engineering runbook secret.')).toContain('eng.txt')
    expect(await found(other, 'Engineering runbook secret.')).not.toContain('eng.txt')
  })

  it('revokes access immediately when someone leaves a group', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    const devId = await addMember(owner, 'dev@acme.test')
    const gid = await createGroup(owner, 'eng')
    await addToGroup(owner, gid, 'dev@acme.test')
    await upload(owner, [
      { path: 'eng.txt', content: 'Engineering runbook secret.', acl: [`group:${gid}`] },
    ])

    const dev = await login('dev@acme.test', 'acme')
    expect(await found(dev, 'Engineering runbook secret.')).toContain('eng.txt')
    // Principals are recomputed per query, so revocation takes effect at once.
    await connect(null, (conn) =>
      conn.exec('delete from group_members where group_id = $1 and user_id = $2', [gid, devId]),
    )
    expect(await found(dev, 'Engineering runbook secret.')).not.toContain('eng.txt')
  })
})

// --- tenant and status boundaries -----------------------------------------

describe('tenant and status boundaries', () => {
  it('never leaks across orgs, even for identical content', async () => {
    const a = await signup('acme', 'owner@acme.test')
    const b = await signup('globex', 'owner@globex.test')
    await upload(a, [{ path: 'shared-name.txt', content: SECRET, acl: ['public-to-org'] }])
    // Org B uploads nothing; identical query returns nothing from org A.
    expect(await found(b, SECRET)).toEqual(new Set())
  })

  it('does not retrieve a deleted document', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    await upload(owner, [
      { path: 'a.txt', content: 'alpha content here', acl: ['public-to-org'] },
    ])
    expect(await found(owner, 'alpha content here')).toContain('a.txt')
    // Re-upload without a.txt marks it deleted; its chunks are gone.
    await app().inject({
      method: 'POST',
      url: '/sources/folder',
      headers: auth(owner),
      payload: { documents: [] },
    })
    expect(await found(owner, 'alpha content here')).not.toContain('a.txt')
  })

  /**
   * `acl: []` is a caller saying nobody. It used to be read as "unset" and handed
   * the org-wide default, so the one request asking for the tightest permission
   * available got the loosest one instead.
   */
  it('treats an empty acl as deny, not as the org-wide default', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    await upload(owner, [{ path: 'locked.txt', content: SECRET, acl: [] }])

    expect(await found(owner, SECRET)).toEqual(new Set())
    const doc = (await listDocuments(owner)).find((d) => d.path === 'locked.txt')
    expect(doc?.acl).toEqual([])
  })

  /**
   * The other half. Not naming an ACL is not the same statement as naming an
   * empty one, and the default has to keep working or every upload breaks.
   */
  it('still gives an absent acl the org-wide default', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    await upload(owner, [{ path: 'open.txt', content: SECRET }])
    expect(await found(owner, SECRET)).toContain('open.txt')
  })
})

// --- GET /documents/:id ----------------------------------------------------
// This route returns content, unlike GET /documents which returns metadata and is
// open to every member. So it carries the ACL predicate in its fetch, and these
// tests are the ones that keep that true.

describe('GET /documents/:id', () => {
  const get = (token: string, id: string) =>
    app().inject({ method: 'GET', url: `/documents/${id}`, headers: auth(token) })

  it('returns content to a permitted reader', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    await upload(owner, [{ path: 'runbook.txt', content: SECRET, acl: ['public-to-org'] }])

    const docId = (await listDocuments(owner))[0]!.id
    const res = await get(owner, docId)

    expect(res.statusCode).toBe(200)
    expect(body<{ content: string }>(res).content).toContain(SECRET)
  })

  /**
   * A member who is not in the group cannot read the document, even holding its
   * id. The id is not a capability.
   *
   * Note the owner is added to the group explicitly: creating a group does not
   * join it, and an owner outside the group is as excluded as anyone else. That
   * is the right behaviour and it is easy to assume otherwise.
   */
  it('hides a document outside the caller’s groups', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    await addMember(owner, 'dev@acme.test')
    const dev = await login('dev@acme.test', 'acme')
    const gid = await createGroup(owner, 'eng')
    await addToGroup(owner, gid, 'owner@acme.test')
    await upload(owner, [{ path: 'eng.txt', content: SECRET, acl: [`group:${gid}`] }])

    const docId = (await listDocuments(owner))[0]!.id

    expect((await get(owner, docId)).statusCode).toBe(200)
    expect((await get(dev, docId)).statusCode).toBe(404)
  })

  /**
   * The tenant boundary and the "does it exist" boundary are the same answer. A
   * 403 here would confirm the document exists to someone in another org.
   */
  it('answers 404, not 403, across orgs', async () => {
    const a = await signup('acme', 'owner@acme.test')
    const b = await signup('globex', 'owner@globex.test')
    await upload(a, [{ path: 'secret.txt', content: SECRET, acl: ['public-to-org'] }])

    const docId = (await listDocuments(a))[0]!.id
    const res = await get(b, docId)

    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain(SECRET)
  })

  /**
   * Content is stitched from chunks by ordinal. Out of order it would still look
   * like a document and read as nonsense.
   */
  it('reassembles chunks in order', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    const longDoc = [1, 2, 3, 4]
      .map((i) => `Section ${i} covers topic number ${i}.`.repeat(12))
      .join('\n\n')
    await upload(owner, [{ path: 'long.txt', content: longDoc, acl: ['public-to-org'] }])

    const docId = (await listDocuments(owner))[0]!.id
    const content = body<{ content: string }>(await get(owner, docId)).content

    expect(content.indexOf('Section 1')).toBeLessThan(content.indexOf('Section 4'))
  })
})
