/**
 * Phase 1: the multi-tenant spine. The load-bearing test is that org A cannot
 * reach org B's data through any endpoint, plus role gates and session lifecycle.
 */

import { describe, expect, it } from 'vitest'
import { connect } from '../src/db.ts'
import { auth, body, signup as signupOrg, useApp, useCleanDb } from './helpers.ts'

const app = useApp()
useCleanDb()

const PW = 'pw-supersecret'

async function signup(slug: string, email: string, password = PW): Promise<string> {
  return (await signupOrg(app(), slug, email, password)).token
}

async function login(email: string, slug?: string, password = PW): Promise<number> {
  const res = await app().inject({
    method: 'POST',
    url: '/auth/login',
    payload: slug === undefined ? { email, password } : { email, password, org_slug: slug },
  })
  return res.statusCode
}

async function loginToken(email: string, slug: string, password = PW): Promise<string> {
  const res = await app().inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password, org_slug: slug },
  })
  expect(res.statusCode).toBe(200)
  return body<{ token: string }>(res).token
}

async function addMember(owner: string, email: string, role = 'member'): Promise<string> {
  const res = await app().inject({
    method: 'POST',
    url: '/members',
    headers: auth(owner),
    payload: { email, password: PW, role },
  })
  return body<{ user_id: string }>(res).user_id
}

async function createGroup(token: string, name: string) {
  return app().inject({ method: 'POST', url: '/groups', headers: auth(token), payload: { name } })
}

// --- signup / login -------------------------------------------------------

describe('signup and login', () => {
  it('makes the first user an owner, and /me reflects it', async () => {
    const token = await signup('acme', 'owner@acme.test')
    const me = body<{ role: string; email: string }>(
      await app().inject({ method: 'GET', url: '/me', headers: auth(token) }),
    )
    expect(me.role).toBe('owner')
    expect(me.email).toBe('owner@acme.test')
  })

  it('rejects a wrong password with 401', async () => {
    await signup('acme', 'owner@acme.test')
    expect(await login('owner@acme.test', undefined, 'nope-nope-nope')).toBe(401)
  })

  it('rejects an org the user is not in with 401', async () => {
    await signup('acme', 'owner@acme.test')
    expect(await login('owner@acme.test', 'globex')).toBe(401)
  })
})

// --- cross-tenant isolation (the load-bearing test) -----------------------

describe('cross-tenant isolation', () => {
  it('will not let one org read another org’s group', async () => {
    const a = await signup('acme', 'owner@acme.test')
    const b = await signup('globex', 'owner@globex.test')

    const groupId = body<{ id: string }>(await createGroup(a, 'engineering')).id

    // Owner of A sees it; owner of B gets a 404, indistinguishable from absent.
    const seen = await app().inject({ method: 'GET', url: `/groups/${groupId}`, headers: auth(a) })
    const unseen = await app().inject({ method: 'GET', url: `/groups/${groupId}`, headers: auth(b) })
    expect(seen.statusCode).toBe(200)
    expect(unseen.statusCode).toBe(404)
  })

  it('scopes the members list to the org', async () => {
    const a = await signup('acme', 'owner@acme.test')
    await signup('globex', 'owner@globex.test')
    const members = body<Array<{ email: string }>>(
      await app().inject({ method: 'GET', url: '/members', headers: auth(a) }),
    )
    expect(new Set(members.map((m) => m.email))).toEqual(new Set(['owner@acme.test']))
  })

  it('allows the same group name in different orgs', async () => {
    const a = await signup('acme', 'owner@acme.test')
    const b = await signup('globex', 'owner@globex.test')
    expect((await createGroup(a, 'eng')).statusCode).toBe(201)
    expect((await createGroup(b, 'eng')).statusCode).toBe(201)
  })

  it('rejects a duplicate group name in the same org with 409', async () => {
    const a = await signup('acme', 'owner@acme.test')
    await createGroup(a, 'eng')
    expect((await createGroup(a, 'eng')).statusCode).toBe(409)
  })
})

// --- role gates -----------------------------------------------------------

describe('role gates', () => {
  it('lets a member list groups but not create one', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    await addMember(owner, 'dev@acme.test')
    const member = await loginToken('dev@acme.test', 'acme')

    expect((await createGroup(member, 'x')).statusCode).toBe(403)
    const listed = await app().inject({ method: 'GET', url: '/groups', headers: auth(member) })
    expect(listed.statusCode).toBe(200)
  })

  it('will not let a member add members', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    await addMember(owner, 'dev@acme.test')
    const member = await loginToken('dev@acme.test', 'acme')
    const res = await app().inject({
      method: 'POST',
      url: '/members',
      headers: auth(member),
      payload: { email: 'x@acme.test', password: 'pw-another1', role: 'member' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects a duplicate member with 409', async () => {
    const owner = await signup('acme', 'owner@acme.test')
    const payload = { email: 'dev@acme.test', password: 'pw-devsecret', role: 'member' }
    const add = () =>
      app().inject({ method: 'POST', url: '/members', headers: auth(owner), payload })
    expect((await add()).statusCode).toBe(201)
    expect((await add()).statusCode).toBe(409)
  })

  /**
   * An org admin must not be able to graft a stranger's account onto their
   * tenant. It reused the existing user row and inserted a membership, ignoring
   * the password in the request, so the admin needed to know nothing about the
   * account to take it.
   */
  it('will not let another org’s admin attach an existing account', async () => {
    await signup('acme', 'victim@acme.test')
    const attacker = await signup('evil', 'boss@evil.test')

    const res = await app().inject({
      method: 'POST',
      url: '/members',
      headers: auth(attacker),
      payload: { email: 'victim@acme.test', password: 'pw-attackerchose', role: 'member' },
    })
    expect(res.statusCode).toBe(409)

    const members = body<Array<{ email: string }>>(
      await app().inject({ method: 'GET', url: '/members', headers: auth(attacker) }),
    )
    expect(new Set(members.map((m) => m.email))).toEqual(new Set(['boss@evil.test']))
  })

  /**
   * The graft also broke the victim's login: a second membership makes
   * `authenticate` refuse a slugless login as ambiguous.
   */
  it('leaves the victim’s own login untouched', async () => {
    await signup('acme', 'victim@acme.test')
    const attacker = await signup('evil', 'boss@evil.test')
    await app().inject({
      method: 'POST',
      url: '/members',
      headers: auth(attacker),
      payload: { email: 'victim@acme.test', password: 'pw-attackerchose', role: 'member' },
    })
    expect(await login('victim@acme.test')).toBe(200)
  })
})

// --- group membership across orgs ----------------------------------------

describe('group membership across orgs', () => {
  it('will not add a foreign user to a group', async () => {
    const a = await signup('acme', 'owner@acme.test')
    await signup('globex', 'outsider@globex.test')
    const groupId = body<{ id: string }>(await createGroup(a, 'eng')).id
    // The user exists globally but is not a member of acme.
    const res = await app().inject({
      method: 'POST',
      url: `/groups/${groupId}/members`,
      headers: auth(a),
      payload: { email: 'outsider@globex.test' },
    })
    expect(res.statusCode).toBe(404)
  })

  /**
   * Resolving the email globally and checking membership second gave two
   * tellable-apart 404s, which let an org admin probe for accounts on the whole
   * platform. Both cases have to read the same.
   */
  it('does not reveal whether an email exists elsewhere', async () => {
    const a = await signup('acme', 'owner@acme.test')
    await signup('globex', 'outsider@globex.test')
    const groupId = body<{ id: string }>(await createGroup(a, 'eng')).id

    const add = (email: string) =>
      app().inject({
        method: 'POST',
        url: `/groups/${groupId}/members`,
        headers: auth(a),
        payload: { email },
      })

    const hasAccountElsewhere = await add('outsider@globex.test')
    const hasNoAccount = await add('nobody@nowhere.test')

    expect(hasAccountElsewhere.statusCode).toBe(404)
    expect(hasNoAccount.statusCode).toBe(404)
    expect(
      body<{ detail: string }>(hasAccountElsewhere).detail.replace('outsider@globex.test', ''),
    ).toBe(body<{ detail: string }>(hasNoAccount).detail.replace('nobody@nowhere.test', ''))
  })
})

// --- session lifecycle ----------------------------------------------------

describe('session lifecycle', () => {
  const me = (token?: string) =>
    app().inject({
      method: 'GET',
      url: '/me',
      ...(token === undefined ? {} : { headers: auth(token) }),
    })

  it('rejects missing and bad tokens with 401', async () => {
    expect((await me()).statusCode).toBe(401)
    expect((await me('not-a-real-token')).statusCode).toBe(401)
  })

  it('rejects an expired session with 401', async () => {
    const token = await signup('acme', 'owner@acme.test')
    expect((await me(token)).statusCode).toBe(200)
    await connect(null, (conn) =>
      conn.exec("update sessions set expires_at = now() - interval '1 hour'"),
    )
    expect((await me(token)).statusCode).toBe(401)
  })

  it('invalidates the session on logout', async () => {
    const token = await signup('acme', 'owner@acme.test')
    const out = await app().inject({ method: 'POST', url: '/auth/logout', headers: auth(token) })
    expect(out.statusCode).toBe(204)
    expect((await me(token)).statusCode).toBe(401)
  })

  it('kills the session when the membership is revoked', async () => {
    const token = await signup('acme', 'owner@acme.test')
    await connect(null, (conn) => conn.exec('delete from memberships'))
    // The session row still exists, but with no membership it no longer resolves.
    expect((await me(token)).statusCode).toBe(401)
  })
})

// --- changing your own password --------------------------------------------

describe('changing your own password', () => {
  const change = (token: string, current: string, next: string) =>
    app().inject({
      method: 'POST',
      url: '/me/password',
      headers: auth(token),
      payload: { current_password: current, new_password: next },
    })

  it('takes effect on the next login', async () => {
    const token = await signup('acme', 'o@acme.test')
    expect((await change(token, PW, 'brand-new-pw-1')).statusCode).toBe(204)
    expect(await login('o@acme.test')).toBe(401)
    expect(await login('o@acme.test', undefined, 'brand-new-pw-1')).toBe(200)
  })

  it('requires the current password', async () => {
    const token = await signup('acme', 'o@acme.test')
    expect((await change(token, 'not-the-password', 'brand-new-pw-1')).statusCode).toBe(401)
  })

  /**
   * The usual reason to change a password is that someone else may know it, so
   * other sessions must not survive it. The caller's own does, or changing it
   * would log you out of the tab you are in.
   */
  it('revokes other sessions but not this one', async () => {
    await signup('acme', 'o@acme.test')
    const stale = await loginToken('o@acme.test', 'acme')
    const current = await loginToken('o@acme.test', 'acme')

    expect((await change(current, PW, 'brand-new-pw-1')).statusCode).toBe(204)
    const staleRes = await app().inject({ method: 'GET', url: '/me', headers: auth(stale) })
    const currentRes = await app().inject({ method: 'GET', url: '/me', headers: auth(current) })
    expect(staleRes.statusCode).toBe(401)
    expect(currentRes.statusCode).toBe(200)
  })

  /**
   * There is no route for it, deliberately: an admin who could reset an owner's
   * password could log in as them, which is the escalation the role-grant
   * ceiling closed arriving through another door.
   */
  it('offers an admin no way to change someone else’s', async () => {
    const owner = await signup('acme', 'o@acme.test')
    const uid = await addMember(owner, 'dev@acme.test')
    for (const url of [`/members/${uid}/password`, `/users/${uid}/password`]) {
      const res = await app().inject({
        method: 'POST',
        url,
        headers: auth(owner),
        payload: { new_password: 'brand-new-pw-1' },
      })
      expect(res.statusCode, `${url} should not exist`).toBe(404)
    }
  })
})
