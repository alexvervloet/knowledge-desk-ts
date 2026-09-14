/**
 * Phase 7 admin surface: member role changes and removal with their guards,
 * group membership management, document ACL editing, and the usage summary.
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Forbidden } from '../src/errors.ts'
import { runPending } from '../src/ingest.ts'
import { TenantScope } from '../src/tenancy.ts'
import { auth, body, signup as signupOrg, useApp, useCleanDb } from './helpers.ts'

const app = useApp()
useCleanDb()

const PW = 'pw-supersecret'

interface Member {
  id: string
  email: string
  role: string
}

async function signup(slug: string, email: string): Promise<string> {
  return (await signupOrg(app(), slug, email, PW)).token
}

function post(token: string, url: string, payload: object) {
  return app().inject({ method: 'POST', url, headers: auth(token), payload })
}

function patch(token: string, url: string, payload: object) {
  return app().inject({ method: 'PATCH', url, headers: auth(token), payload })
}

function del(token: string, url: string) {
  return app().inject({ method: 'DELETE', url, headers: auth(token) })
}

function get(token: string, url: string) {
  return app().inject({ method: 'GET', url, headers: auth(token) })
}

async function addMember(owner: string, email: string, role = 'member'): Promise<string> {
  const res = await post(owner, '/members', { email, password: PW, role })
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

async function meId(token: string): Promise<string> {
  return body<{ user_id: string }>(await get(token, '/me')).user_id
}

async function rolesOf(token: string): Promise<Record<string, string>> {
  const members = body<Member[]>(await get(token, '/members'))
  return Object.fromEntries(members.map((m) => [m.email, m.role]))
}

async function upload(
  token: string,
  documents: Array<{ path: string; content: string; acl?: string[] }>,
): Promise<void> {
  await post(token, '/sources/folder', { documents })
  await runPending()
}

// --- member role and removal ----------------------------------------------

describe('member role and removal', () => {
  it('changes a member role', async () => {
    const owner = await signup('acme', 'o@acme.test')
    const uid = await addMember(owner, 'dev@acme.test')
    expect((await patch(owner, `/members/${uid}`, { role: 'admin' })).statusCode).toBe(200)
    expect((await rolesOf(owner))['dev@acme.test']).toBe('admin')
  })

  it('will not let you change your own role', async () => {
    const owner = await signup('acme', 'o@acme.test')
    const res = await patch(owner, `/members/${await meId(owner)}`, { role: 'member' })
    expect(res.statusCode).toBe(403)
  })

  it('will not demote the last owner', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'adm@acme.test', 'admin')
    const admin = await login('adm@acme.test', 'acme')
    // An admin tries to demote the sole owner: refused to keep an owner in the org.
    const res = await patch(admin, `/members/${await meId(owner)}`, { role: 'member' })
    expect(res.statusCode).toBe(403)
  })

  it('removes a member', async () => {
    const owner = await signup('acme', 'o@acme.test')
    const uid = await addMember(owner, 'dev@acme.test')
    expect((await del(owner, `/members/${uid}`)).statusCode).toBe(204)
    expect(Object.keys(await rolesOf(owner))).not.toContain('dev@acme.test')
  })

  it('will not let you remove yourself or the last owner', async () => {
    const owner = await signup('acme', 'o@acme.test')
    expect((await del(owner, `/members/${await meId(owner)}`)).statusCode).toBe(403)
  })

  it('will not let a member administer', async () => {
    const owner = await signup('acme', 'o@acme.test')
    const uid = await addMember(owner, 'dev@acme.test')
    const member = await login('dev@acme.test', 'acme')
    expect((await patch(member, `/members/${uid}`, { role: 'admin' })).statusCode).toBe(403)
  })
})

// --- the role-grant ceiling ------------------------------------------------
//
// Granting a role you do not hold is privilege escalation with an extra step:
// whoever creates the account also chooses its password, so an admin who can mint
// an owner can log in as it and hold every owner power.

describe('the role-grant ceiling', () => {
  it('stops an admin creating an owner', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'adm@acme.test', 'admin')
    const admin = await login('adm@acme.test', 'acme')
    const res = await post(admin, '/members', {
      email: 'puppet@acme.test',
      password: PW,
      role: 'owner',
    })
    expect(res.statusCode).toBe(403)
    expect(body<{ detail: string }>(res).detail).toContain('cannot grant role owner')
    // And the account does not exist, so it cannot be logged into.
    const attempt = await app().inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'puppet@acme.test', password: PW },
    })
    expect(attempt.statusCode).toBe(401)
  })

  it('stops an admin promoting anyone to owner', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'adm@acme.test', 'admin')
    const uid = await addMember(owner, 'dev@acme.test')
    const admin = await login('adm@acme.test', 'acme')
    expect((await patch(admin, `/members/${uid}`, { role: 'owner' })).statusCode).toBe(403)
    expect((await rolesOf(owner))['dev@acme.test']).toBe('member')
  })

  it('still lets an admin grant up to its own rank', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'adm@acme.test', 'admin')
    const admin = await login('adm@acme.test', 'acme')
    const created = await post(admin, '/members', {
      email: 'a@acme.test',
      password: PW,
      role: 'admin',
    })
    expect(created.statusCode).toBe(201)
    const uid = await addMember(admin, 'b@acme.test')
    expect((await patch(admin, `/members/${uid}`, { role: 'admin' })).statusCode).toBe(200)
  })

  it('still lets an owner grant ownership', async () => {
    const owner = await signup('acme', 'o@acme.test')
    const uid = await addMember(owner, 'co@acme.test', 'owner')
    expect((await patch(owner, `/members/${uid}`, { role: 'member' })).statusCode).toBe(200)
    const co = await addMember(owner, 'co2@acme.test')
    expect((await patch(owner, `/members/${co}`, { role: 'owner' })).statusCode).toBe(200)
  })
})

// --- where authorization lives ---------------------------------------------

/**
 * Role checks used to be split between the route layer and the data layer, with
 * no rule saying which lived where, so reading the routes gave a wrong picture of
 * the authorization model. They are all in TenantScope now, which is the layer a
 * new route cannot bypass — so the gate has to hold when the method is called
 * directly, not only through its endpoint.
 */
describe('admin-only operations are gated in the data layer', () => {
  const CALLS: Array<[string, (s: TenantScope) => Promise<unknown>]> = [
    ['syncSource', (s) => s.syncSource('local-folder', [])],
    ['deleteDocument', (s) => s.deleteDocument(randomUUID())],
    ['updateDocumentAcl', (s) => s.updateDocumentAcl(randomUUID(), [])],
    ['export', (s) => s.export()],
    ['countAudit', (s) => s.countAudit()],
    ['listAudit', (s) => s.listAudit()],
    ['usageSummary', (s) => s.usageSummary()],
    ['createGroup', (s) => s.createGroup('g')],
    ['deleteGroup', (s) => s.deleteGroup(randomUUID())],
    ['removeMember', (s) => s.removeMember(randomUUID())],
  ]

  it.each(CALLS)('%s refuses a member', async (_name, call) => {
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'dev@acme.test')
    const me = body<{ user_id: string; org_id: string; email: string }>(
      await get(await login('dev@acme.test', 'acme'), '/me'),
    )
    const memberScope = new TenantScope({
      userId: me.user_id,
      orgId: me.org_id,
      role: 'member',
      email: me.email,
    })

    await expect(call(memberScope)).rejects.toBeInstanceOf(Forbidden)
  })

  /**
   * The one listing with no role gate. Seeing which documents the org holds is
   * not the same as being able to read them: retrieval enforces the ACL per
   * document, and the Sources tab is for everyone.
   */
  it('leaves the document listing open to members on purpose', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await upload(owner, [{ path: 'a.txt', content: 'hello', acl: ['public-to-org'] }])
    await addMember(owner, 'dev@acme.test')
    const dev = await login('dev@acme.test', 'acme')
    expect((await get(dev, '/documents')).statusCode).toBe(200)
  })
})

// --- group management ------------------------------------------------------

describe('group management', () => {
  it('adds, lists and removes a group member', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await addMember(owner, 'dev@acme.test')
    const gid = body<{ id: string }>(await post(owner, '/groups', { name: 'eng' })).id

    await post(owner, `/groups/${gid}/members`, { email: 'dev@acme.test' })
    const members = body<Member[]>(await get(owner, `/groups/${gid}/members`))
    expect(new Set(members.map((m) => m.email))).toEqual(new Set(['dev@acme.test']))

    const uid = members[0]!.id
    expect((await del(owner, `/groups/${gid}/members/${uid}`)).statusCode).toBe(204)
    expect(body(await get(owner, `/groups/${gid}/members`))).toEqual([])
  })

  it('deletes a group', async () => {
    const owner = await signup('acme', 'o@acme.test')
    const gid = body<{ id: string }>(await post(owner, '/groups', { name: 'eng' })).id
    expect((await del(owner, `/groups/${gid}`)).statusCode).toBe(204)
    expect(body(await get(owner, '/groups'))).toEqual([])
  })
})

// --- document ACL editing --------------------------------------------------

it('changes visibility when a document ACL is edited', async () => {
  const owner = await signup('acme', 'o@acme.test')
  const xId = await addMember(owner, 'x@acme.test')
  await addMember(owner, 'y@acme.test')
  await upload(owner, [
    { path: 'd.txt', content: 'shared secret text', acl: ['public-to-org'] },
  ])
  const docId = body<Array<{ id: string }>>(await get(owner, '/documents'))[0]!.id

  const y = await login('y@acme.test', 'acme')
  const search = (token: string) => post(token, '/search', { query: 'shared secret text' })
  expect(body<unknown[]>(await search(y)).length).toBeGreaterThan(0) // visible now

  // Restrict to user X; Y loses access, X keeps it.
  const edited = await patch(owner, `/documents/${docId}/acl`, { acl: [`user:${xId}`] })
  expect(edited.statusCode).toBe(200)
  expect(body(await search(y))).toEqual([])
  const x = await login('x@acme.test', 'acme')
  expect(body<unknown[]>(await search(x)).length).toBeGreaterThan(0)
})

// --- pagination ------------------------------------------------------------

describe('pagination', () => {
  const fiveDocs = Array.from({ length: 5 }, (_, i) => ({
    path: `doc${String(i).padStart(2, '0')}.txt`,
    content: `content ${i}`,
    acl: ['public-to-org'],
  }))

  it('paginates documents', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await upload(owner, fiveDocs)

    const page1 = body<Array<{ id: string; path: string }>>(
      await get(owner, '/documents?limit=2&offset=0'),
    )
    const page2 = body<Array<{ id: string; path: string }>>(
      await get(owner, '/documents?limit=2&offset=2'),
    )
    expect(page1.map((d) => d.path)).toEqual(['doc00.txt', 'doc01.txt'])
    expect(page2.map((d) => d.path)).toEqual(['doc02.txt', 'doc03.txt'])
    // Pages are disjoint, which is what makes offset paging usable at all.
    const ids = new Set(page1.map((d) => d.id))
    expect(page2.some((d) => ids.has(d.id))).toBe(false)
  })

  it('paginates members', async () => {
    const owner = await signup('acme', 'o@acme.test')
    for (let i = 0; i < 3; i++) await addMember(owner, `dev${i}@acme.test`)
    expect(body<unknown[]>(await get(owner, '/members?limit=2'))).toHaveLength(2)
    // 4 members total: the owner plus three.
    expect(body<unknown[]>(await get(owner, '/members?limit=100&offset=2'))).toHaveLength(2)
  })

  /**
   * The client cannot build paging controls from a page alone, so the total rides
   * along in a header. It must count everything, not the slice.
   */
  it('reports the total independent of the page', async () => {
    const owner = await signup('acme', 'o@acme.test')
    await upload(owner, fiveDocs)

    const page = await get(owner, '/documents?limit=2&offset=0')
    expect(body<unknown[]>(page)).toHaveLength(2)
    expect(page.headers['x-total-count']).toBe('5')

    const last = await get(owner, '/documents?limit=2&offset=4')
    expect(body<unknown[]>(last)).toHaveLength(1) // partial final page
    expect(last.headers['x-total-count']).toBe('5')

    // Members and audit expose it too, and the count is org-scoped.
    expect((await get(owner, '/members')).headers['x-total-count']).toBe('1')
    expect(Number((await get(owner, '/audit')).headers['x-total-count'])).toBeGreaterThan(0)
  })

  it('scopes the total to the org', async () => {
    const a = await signup('acme', 'o@acme.test')
    const b = await signup('globex', 'o@globex.test')
    await upload(a, [{ path: 'a.txt', content: 'x', acl: ['public-to-org'] }])
    expect((await get(a, '/documents')).headers['x-total-count']).toBe('1')
    expect((await get(b, '/documents')).headers['x-total-count']).toBe('0')
  })

  it('rejects bad bounds', async () => {
    const owner = await signup('acme', 'o@acme.test')
    expect((await get(owner, '/documents?limit=0')).statusCode).toBe(422)
    expect((await get(owner, '/documents?limit=99999')).statusCode).toBe(422)
    expect((await get(owner, '/documents?offset=-1')).statusCode).toBe(422)
  })
})

// --- usage summary ---------------------------------------------------------

it('shapes the usage summary and keeps it admin-only', async () => {
  const owner = await signup('acme', 'o@acme.test')
  await addMember(owner, 'dev@acme.test')
  const dev = await login('dev@acme.test', 'acme')
  expect((await get(dev, '/usage')).statusCode).toBe(403)

  const usage = body<{
    questions: { cap: number }
    spend: Record<string, unknown>
  }>(await get(owner, '/usage'))
  expect(new Set(Object.keys(usage))).toEqual(
    new Set(['questions', 'spend', 'storage', 'top_queries']),
  )
  expect(usage.questions.cap).toBeGreaterThanOrEqual(1)
  expect(usage.spend).toHaveProperty('budget_usd')
})
