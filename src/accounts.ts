/**
 * Account-level operations: identities, org grants, and sessions.
 *
 * This module owns things that inherently cross a single org boundary: creating a
 * global user, granting a user access to an org (a membership), and resolving a
 * session into an acting context. Once a caller is acting inside one org, all
 * org-scoped data goes through TenantScope instead.
 */

import {
  dummyHash,
  hashPassword,
  hashToken,
  newSessionToken,
  verifyPassword,
} from './auth.ts'
import { settings } from './config.ts'
import { connect, isUniqueViolation, type Conn } from './db.ts'
import { AuthError, Conflict } from './errors.ts'
import type { AuthContext } from './tenancy.ts'

/** Sign-up: create an org and its first user as owner, in one transaction. */
export async function createOrgWithOwner(
  orgSlug: string,
  orgName: string,
  email: string,
  password: string,
): Promise<AuthContext> {
  const normalized = email.trim().toLowerCase()
  try {
    return await connect(null, async (conn) => {
      const org = await conn.require('insert into orgs(slug, name) values ($1, $2) returning id', [
        orgSlug,
        orgName,
      ])
      const user = await conn.require(
        'insert into users(email, password_hash) values ($1, $2) returning id',
        [normalized, hashPassword(password)],
      )
      await conn.exec(
        "insert into memberships(user_id, org_id, role) values ($1, $2, 'owner')",
        [user.id, org.id],
      )
      return {
        userId: String(user.id),
        orgId: String(org.id),
        role: 'owner',
        email: normalized,
      }
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw new Conflict('org slug or email already taken')
    throw err
  }
}

/**
 * Create a user and grant them access to an org. Returns the user id. The caller
 * must already be authorized (admin+).
 *
 * Only ever creates. An email that already has an account is refused, and that
 * refusal is the point: this used to reuse the existing user and just insert a
 * membership, which let any org admin attach a stranger's account to their own
 * tenant. Nothing in the request is evidence the account holder agreed — the
 * password argument is one the admin chose, and it was silently discarded on
 * that path, so the admin did not even need to know the real one.
 *
 * Joining an existing account to a second org is a real need, and it needs an
 * invitation the invitee accepts. That is not built. Until it is, a 409 is the
 * honest answer, and a silent graft is not.
 */
export async function addMember(
  orgId: string,
  email: string,
  password: string,
  role: string,
): Promise<string> {
  const normalized = email.trim().toLowerCase()
  try {
    return await connect(null, async (conn) => {
      const user = await conn.require(
        'insert into users(email, password_hash) values ($1, $2) returning id',
        [normalized, hashPassword(password)],
      )
      // Unreachable by unique violation: the user was created a statement ago,
      // so no membership for them can exist yet. Same transaction, so a failure
      // here leaves no orphan user behind.
      await conn.exec('insert into memberships(user_id, org_id, role) values ($1, $2, $3)', [
        user.id,
        orgId,
        role,
      ])
      return String(user.id)
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Conflict(
        'that email already has an account; an existing account can only' +
          ' join another org by invitation',
      )
    }
    throw err
  }
}

/** Verify credentials and resolve which org the session acts in. */
export async function authenticate(
  email: string,
  password: string,
  orgSlug?: string | null,
): Promise<AuthContext> {
  const normalized = email.trim().toLowerCase()
  const { user, memberships } = await connect(null, async (conn) => {
    const found = await conn.one<{ id: string; password_hash: string }>(
      'select id, password_hash from users where email = $1',
      [normalized],
    )
    if (found === null) {
      // Spend the same bcrypt time a real account would, so the response time
      // does not disclose whether the email is registered.
      verifyPassword(password, dummyHash())
      throw new AuthError('invalid email or password')
    }
    if (!verifyPassword(password, found.password_hash)) {
      throw new AuthError('invalid email or password')
    }
    const rows = await conn.query<{ org_id: string; role: string; slug: string }>(
      'select m.org_id, m.role, o.slug from memberships m' +
        ' join orgs o on o.id = m.org_id where m.user_id = $1',
      [found.id],
    )
    return { user: found, memberships: rows }
  })

  if (memberships.length === 0) throw new AuthError('user has no org memberships')
  let chosen: { org_id: string; role: string; slug: string } | undefined
  if (orgSlug !== undefined && orgSlug !== null) {
    chosen = memberships.find((m) => m.slug === orgSlug)
    if (chosen === undefined) throw new AuthError(`not a member of org: ${orgSlug}`)
  } else if (memberships.length === 1) {
    chosen = memberships[0]
  } else {
    throw new AuthError('multiple orgs; specify org_slug')
  }

  return {
    userId: String(user.id),
    orgId: String(chosen!.org_id),
    role: chosen!.role,
    email: normalized,
  }
}

/** Persist a session for the acting context; return the raw bearer token. */
export async function createSession(ctx: AuthContext): Promise<string> {
  const [raw, tokenHash] = newSessionToken()
  const expiresAt = new Date(Date.now() + settings.sessionTtlHours * 3600 * 1000)
  await connect(null, (conn) =>
    conn.exec(
      'insert into sessions(token_hash, user_id, org_id, expires_at) values ($1, $2, $3, $4)',
      [tokenHash, ctx.userId, ctx.orgId, expiresAt],
    ),
  )
  return raw
}

/** Return the acting context for a live token, or null if missing/expired. */
export async function resolveSession(rawToken: string): Promise<AuthContext | null> {
  const row = await connect(null, (conn) =>
    conn.one<{
      user_id: string
      org_id: string
      expires_at: Date
      role: string
      email: string
    }>(
      'select s.user_id, s.org_id, s.expires_at, m.role, u.email' +
        ' from sessions s' +
        ' join memberships m on m.user_id = s.user_id and m.org_id = s.org_id' +
        ' join users u on u.id = s.user_id' +
        ' where s.token_hash = $1',
      [hashToken(rawToken)],
    ),
  )
  if (row === null) return null
  if (row.expires_at.getTime() <= Date.now()) return null
  return {
    userId: String(row.user_id),
    orgId: String(row.org_id),
    role: row.role,
    email: row.email,
  }
}

export async function deleteSession(rawToken: string): Promise<void> {
  await connect(null, (conn) =>
    conn.exec('delete from sessions where token_hash = $1', [hashToken(rawToken)]),
  )
}

/**
 * Replace a user's password after verifying the current one. Returns how many of
 * their other sessions were revoked.
 *
 * Self-service only, and deliberately so: an admin who could reset another
 * member's password could reset an owner's and log in as them, which is the
 * privilege escalation the role-grant ceiling closed, arriving through a
 * different door. Changing a password is something only its owner can do.
 *
 * Every other session for the user is revoked, because the usual reason to
 * change a password is that someone else might know it. The caller's own session
 * survives, so changing it does not log you out of the tab you are in.
 */
export function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepTokenHash: string,
): Promise<number> {
  return connect(null, async (conn) => {
    const row = await conn.one<{ password_hash: string }>(
      'select password_hash from users where id = $1',
      [userId],
    )
    if (row === null || !verifyPassword(currentPassword, row.password_hash)) {
      throw new AuthError('current password is incorrect')
    }
    await conn.exec('update users set password_hash = $1 where id = $2', [
      hashPassword(newPassword),
      userId,
    ])
    return conn.exec('delete from sessions where user_id = $1 and token_hash <> $2', [
      userId,
      keepTokenHash,
    ])
  })
}

/**
 * Delete sessions that are past their expiry. Returns how many went.
 *
 * resolveSession already refuses an expired row, so this is housekeeping rather
 * than a security control: without it the table only ever grows, and with a
 * 30-day TTL that is a lot of rows nobody will ever read again. Run from the
 * worker, which is the process that already wakes up on a timer.
 */
export function purgeExpiredSessions(): Promise<number> {
  return connect(null, (conn) => conn.exec('delete from sessions where expires_at <= now()'))
}

/**
 * Delete any of `userIds` left with no membership, and return how many.
 *
 * A user row is only reachable through a membership. Login takes an org slug,
 * and every read is org-scoped, so a user with no memberships is not an account
 * anybody can use. Its email stays permanently unavailable, because both signup
 * and `addMember` refuse an email that already exists.
 *
 * That refusal is right for a live account, for the reason `addMember` documents
 * at length: nothing in an admin's request is evidence the account holder agreed
 * to anything. It is wrong for a row that belongs to nobody, which is what is
 * left behind when a tenant is deleted or a member is removed from their only
 * org. Before this existed, deleting a tenant burned its owner's email address
 * for good.
 *
 * Audit history survives. `audit_log.actor_user_id` is `on delete set null`
 * exactly so that a user can be erased without erasing the record of what they
 * did, and any audit rows belonging to the deleted org have already gone with it.
 *
 * Scoped to the ids the caller just affected rather than sweeping the table, so
 * a bug elsewhere cannot turn an unrelated account into collateral.
 */
export async function purgeStrandedUsers(conn: Conn, userIds: string[]): Promise<number> {
  if (userIds.length === 0) return 0
  return conn.exec(
    'delete from users where id = any($1::uuid[])' +
      ' and not exists (select 1 from memberships where user_id = users.id)',
    [userIds],
  )
}

/**
 * Delete an entire tenant. Every org-scoped table references orgs with
 * `on delete cascade`, so this removes memberships, documents, chunks, answers,
 * audit records, and sessions in one statement.
 *
 * Users are not org-scoped, because one person can belong to several orgs, so
 * the cascade leaves them. Anyone whose only membership was this org is then
 * stranded and is deleted too; see `purgeStrandedUsers`. A member of another org
 * keeps their account and their access to it.
 */
export async function deleteOrg(orgId: string): Promise<void> {
  await connect(null, async (conn) => {
    const rows = await conn.query<{ user_id: string }>(
      'select user_id from memberships where org_id = $1',
      [orgId],
    )
    await conn.exec('delete from orgs where id = $1', [orgId])
    await purgeStrandedUsers(
      conn,
      rows.map((r) => String(r.user_id)),
    )
  })
}
