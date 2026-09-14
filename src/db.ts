/**
 * Database access: a shared connection pool, and the per-request tenant context
 * that row-level security keys on.
 *
 * The tenant GUC is set **transaction-scoped** (`set_config(..., true)`), which is
 * load-bearing once connections are pooled. A session-scoped setting survives the
 * commit and rides the connection back into the pool, so the next request to borrow
 * that connection would silently inherit the previous tenant's org context. A
 * transaction-scoped setting reverts on commit, so a recycled connection always
 * starts with no tenant and the RLS policies deny by default.
 *
 * Because the GUC is transaction-scoped, every statement in a `connect(orgId)`
 * block must run inside the same transaction. psycopg opens one implicitly on the
 * first statement; node-postgres does not, so `connect` issues an explicit `begin`
 * and commits or rolls back at block exit. That difference is the whole reason
 * this file is not a line-for-line port of db.py.
 */

import pg from 'pg'
import pgvector from 'pgvector/pg'
import { settings } from './config.ts'

/**
 * A result row. Postgres column names come back as object keys, and their values
 * are whatever the driver decoded them to, so this is as precise as the driver
 * can be. Callers narrow at the point of use.
 */
export type Row = Record<string, unknown>

export interface Conn {
  /** Run a statement inside this connection's open transaction. */
  query<T extends Row = Row>(text: string, values?: unknown[]): Promise<T[]>
  /** Run a statement and return the number of rows it affected. */
  exec(text: string, values?: unknown[]): Promise<number>
  /** Run a statement expected to yield at most one row. */
  one<T extends Row = Row>(text: string, values?: unknown[]): Promise<T | null>
  /**
   * Run a statement guaranteed to produce a row.
   *
   * An aggregate, or an INSERT with RETURNING, always yields exactly one row, so
   * nothing back means the query or the schema changed underneath us. Failing
   * loudly here beats a TypeError three frames away, and it lets the type checker
   * see that the caller is not indexing a nullable.
   */
  require<T extends Row = Row>(text: string, values?: unknown[]): Promise<T>
}

let pool: pg.Pool | null = null

/**
 * Clients that have had their per-connection setup run.
 *
 * psycopg's pool takes a `configure` callback and waits for it before handing
 * the connection out. node-postgres has no such hook: its `connect` event fires
 * with no way to make the pool wait, so setup kicked off there races the first
 * real query on that client, and pgvector's type registration losing that race
 * means a vector column comes back as a string. Tracking configured clients here
 * and awaiting the setup on first checkout is what psycopg was doing for free.
 *
 * Weak so a discarded client does not keep an entry alive.
 */
const configured = new WeakSet<pg.PoolClient>()

async function configure(client: pg.PoolClient): Promise<void> {
  if (configured.has(client)) return
  await pgvector.registerTypes(client)
  // Iterative scan makes the HNSW index safe under our ACL filter. Without it
  // the index returns k candidates, the permission filter removes most of them,
  // and the caller silently gets fewer results than they asked for. Relaxed
  // order lets pgvector re-probe until enough rows survive the filter.
  //
  // Session-scoped on purpose, unlike the tenant GUC: this setting is identical
  // for every tenant, so a pooled connection carrying it between requests is
  // correct rather than a leak.
  await client.query('set hnsw.iterative_scan = relaxed_order')
  configured.add(client)
}

export function getPool(): pg.Pool {
  if (pool === null) {
    pool = new pg.Pool({
      connectionString: settings.appDatabaseUrl,
      min: settings.dbPoolMin,
      max: settings.dbPoolMax,
    })
    // A pooled client can be killed server-side between checkouts. Without a
    // listener node-postgres turns that into an unhandled 'error' event and takes
    // the process down; with one it discards the client and hands out another.
    pool.on('error', (err) => {
      console.error('[db] idle client error, discarding connection:', err.message)
    })
  }
  return pool
}

export async function closePool(): Promise<void> {
  if (pool !== null) {
    const closing = pool
    pool = null
    await closing.end()
  }
}

function wrap(client: pg.PoolClient): Conn {
  const query = async <T extends Row>(text: string, values: unknown[] = []): Promise<T[]> => {
    const result = await client.query(text, values)
    return result.rows as T[]
  }
  return {
    query,
    async exec(text, values = []) {
      const result = await client.query(text, values)
      return result.rowCount ?? 0
    },
    async one<T extends Row>(text: string, values: unknown[] = []) {
      const rows = await query<T>(text, values)
      return rows[0] ?? null
    },
    async require<T extends Row>(text: string, values: unknown[] = []) {
      const rows = await query<T>(text, values)
      const row = rows[0]
      if (row === undefined) throw new Error('query returned no row where one was guaranteed')
      return row
    },
  }
}

/**
 * Borrow a pooled connection. Commits on clean exit, rolls back on error.
 *
 * When `orgId` is given it is set as the transaction-scoped `app.current_org`
 * GUC that the RLS policies read. With no orgId the policies see an empty
 * setting and return no rows, so a query that forgets its tenant filter yields
 * nothing rather than leaking across tenants.
 */
export async function connect<T>(
  orgId: string | null,
  fn: (conn: Conn) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  try {
    await configure(client)
    await client.query('begin')
    if (orgId !== null) {
      await client.query('select set_config($1, $2, true)', ['app.current_org', orgId])
    }
    const result = await fn(wrap(client))
    await client.query('commit')
    return result
  } catch (err) {
    // A rollback on an already-broken connection throws again and would replace
    // the real error with a meaningless one. The original failure is what the
    // caller needs.
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
