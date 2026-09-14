/**
 * A durable, Postgres-backed job queue. No Redis: a `jobs` table plus
 * `SELECT ... FOR UPDATE SKIP LOCKED` gives at-least-once delivery with safe
 * concurrent workers, which is all ingestion needs. Jobs are idempotent by their
 * `idempotency_key`, so enqueuing the same unit of work twice is a no-op.
 *
 * On row-level security: `jobs` carries an `org_id` and is the one such table
 * without an RLS policy, which is deliberate and worth stating because every other
 * org-scoped table has one. A worker claims the next due job without knowing whose
 * it is — that is the whole point of a shared queue — so it cannot set the tenant
 * GUC before the claim, and a policy here would make the queue unreadable to the
 * only process that drains it. The isolation that matters happens after the claim:
 * the job's `org_id` becomes the tenant context for the work itself, so
 * `processIngestDocument` runs inside the same RLS the API does. A job row holds
 * a document id, never document content.
 */

import { settings } from './config.ts'
import { connect } from './db.ts'

export interface Job {
  // An index signature so the row type satisfies db.Row. Postgres hands back
  // whatever the select listed, and these six are what this one lists.
  [column: string]: unknown
  id: string
  org_id: string
  kind: string
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
}

/**
 * Enqueue a job. Returns true if a new job was created, false if one with this
 * idempotencyKey already existed.
 */
export async function enqueue(
  orgId: string,
  kind: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  maxAttempts?: number,
): Promise<boolean> {
  const row = await connect(null, (conn) =>
    conn.one(
      'insert into jobs(org_id, kind, payload, idempotency_key, max_attempts)' +
        ' values ($1, $2, $3, $4, $5)' +
        ' on conflict (idempotency_key) do nothing returning id',
      [orgId, kind, JSON.stringify(payload), idempotencyKey, maxAttempts ?? settings.jobMaxAttempts],
    ),
  )
  return row !== null
}

/**
 * Atomically claim the oldest due job, marking it running. Concurrent workers
 * skip each other's locked rows.
 */
export function claimOne(): Promise<Job | null> {
  return connect(null, (conn) =>
    conn.one<Job>(
      "update jobs set status = 'running', attempts = attempts + 1," +
        ' updated_at = now()' +
        ' where id = (' +
        '   select id from jobs' +
        "   where status = 'queued' and run_after <= now()" +
        '   order by created_at for update skip locked limit 1)' +
        ' returning id, org_id, kind, payload, attempts, max_attempts',
    ),
  )
}

export async function markSucceeded(jobId: string): Promise<void> {
  await connect(null, (conn) =>
    conn.exec(
      "update jobs set status = 'succeeded', last_error = null," +
        ' updated_at = now() where id = $1',
      [jobId],
    ),
  )
}

function backoffSeconds(attempts: number): number {
  return Math.min(300, 2 ** attempts)
}

/**
 * Record a failure. Requeue with a delay if attempts remain, otherwise
 * dead-letter. Returns the resulting status ('queued' or 'dead').
 */
export function markFailed(
  jobId: string,
  error: string,
  backoff?: number,
): Promise<'queued' | 'dead'> {
  return connect(null, async (conn) => {
    const job = await conn.one<{ attempts: number; max_attempts: number }>(
      'select attempts, max_attempts from jobs where id = $1',
      [jobId],
    )
    if (job === null) return 'dead'
    if (job.attempts >= job.max_attempts) {
      await conn.exec(
        "update jobs set status = 'dead', last_error = $1, updated_at = now() where id = $2",
        [error, jobId],
      )
      return 'dead'
    }
    const delay = backoff ?? backoffSeconds(job.attempts)
    await conn.exec(
      "update jobs set status = 'queued', last_error = $1," +
        ' run_after = now() + make_interval(secs => $2), updated_at = now()' +
        ' where id = $3',
      [error, delay, jobId],
    )
    return 'queued'
  })
}
