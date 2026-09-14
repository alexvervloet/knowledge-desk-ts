/**
 * Password hashing and session tokens.
 *
 * Passwords: bcrypt over a sha256 pre-hash so passwords longer than bcrypt's
 * 72-byte input limit are not silently truncated (a real correctness bug: two
 * distinct long passwords could otherwise collide).
 *
 * Sessions: the client holds an opaque random bearer token; the database stores
 * only its sha256, so a database read cannot recover a live token.
 */

import { createHash, randomBytes } from 'node:crypto'
import { compareSync, hashSync } from '@node-rs/bcrypt'

/** owner > admin > member. requireRole compares these ranks. */
export const ROLE_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 }

function prehash(password: string): Buffer {
  return Buffer.from(createHash('sha256').update(password, 'utf8').digest('base64'), 'ascii')
}

export function hashPassword(password: string): string {
  return hashSync(prehash(password))
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  try {
    return compareSync(prehash(password), passwordHash)
  } catch {
    return false
  }
}

let cachedDummy: string | null = null

/**
 * A real bcrypt hash of a value nothing can log in with.
 *
 * Verifying against this on the user-not-found path is what stops login from
 * answering "does this account exist" through its own response time. Skipping
 * bcrypt when there is no user made a miss finish in about 4ms against roughly
 * 240ms for a hit, which is a clean oracle needing no error-message difference
 * to read. Cached because generating it costs exactly as much as the
 * verification it is standing in for.
 */
export function dummyHash(): string {
  cachedDummy ??= hashPassword(tokenUrlsafe(32))
  return cachedDummy
}

/** The Python side's `secrets.token_urlsafe`: n random bytes, base64url, no padding. */
function tokenUrlsafe(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

/** Return [rawTokenForClient, tokenHashForStorage]. */
export function newSessionToken(): [string, string] {
  const raw = tokenUrlsafe(32)
  return [raw, hashToken(raw)]
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

export function roleAtLeast(actual: string, required: string): boolean {
  return (ROLE_RANK[actual] ?? 0) >= (ROLE_RANK[required] ?? 99)
}
