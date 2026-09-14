/**
 * Ingestion: turn uploaded files into embedded, per-tenant chunks.
 *
 * Two halves. `syncDocuments` runs on the request path: it captures content,
 * detects what actually changed by hash, marks deletions, and enqueues a job per
 * changed document. `processIngestDocument` runs in the worker: it chunks,
 * embeds, and replaces a document's chunks. Splitting them keeps embedding (slow,
 * and for Voyage a network call) off the request and behind the retrying queue.
 */

import { createHash } from 'node:crypto'
import pgvector from 'pgvector/pg'
import { chunkText } from './chunking.ts'
import { connect, type Conn } from './db.ts'
import { getEmbedder } from './embeddings.ts'
import * as jobs from './jobs.ts'
import * as pii from './pii.ts'

// What a document gets when the upload does not mention an ACL at all. An upload
// that names an empty one is a different statement and is stored as given.
export const DEFAULT_ACL = ['public-to-org']

export interface UploadItem {
  path: string
  content: string
  acl?: string[] | null | undefined
}

export interface SyncResult {
  enqueued: number
  unchanged: number
  deleted: number
}

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Reconcile an org's documents for one source against `items` (each with path,
 * content, and optional acl). Enqueues an ingest job per new/changed document,
 * leaves unchanged ones alone, and marks missing ones deleted.
 *
 * `precheck` runs inside the write transaction, before anything is written, so a
 * caller enforcing a quota can lock and measure without another transaction
 * slipping in between the measurement and the write. Throwing from it aborts the
 * whole sync.
 */
export async function syncDocuments(
  orgId: string,
  source: string,
  items: UploadItem[],
  precheck?: (conn: Conn) => Promise<void>,
): Promise<SyncResult> {
  let enqueued = 0
  let unchanged = 0
  let deleted = 0
  const incomingPaths = new Set(items.map((i) => i.path))
  const toEnqueue: Array<[documentId: string, idempotencySuffix: string]> = []

  deleted = await connect(orgId, async (conn) => {
    if (precheck !== undefined) await precheck(conn)
    const existingRows = await conn.query<{
      id: string
      path: string
      content_hash: string
      status: string
    }>(
      'select id, path, content_hash, status from documents where org_id = $1 and source = $2',
      [orgId, source],
    )
    const existing = new Map(existingRows.map((r) => [r.path, r]))

    for (const item of items) {
      const content = item.content
      const contentHash = hash(content)
      // `??` here rather than `||`: `||` treated an explicit empty ACL as "unset"
      // and handed the document the org-wide default, so a caller asking for
      // "nobody" got "everybody in this org", the one mistake in this direction
      // that a permission system must not make. Absent means unspecified and
      // takes the default; empty means empty, and matches no principal.
      const acl = item.acl ?? DEFAULT_ACL
      const prior = existing.get(item.path)

      if (prior !== undefined && prior.content_hash === contentHash && prior.status === 'ingested') {
        unchanged += 1
        continue
      }

      const piiTypes = pii.detectTypes(content)
      const doc = await conn.require<{ id: string; revision: number }>(
        'insert into documents(org_id, source, path, content, content_hash, acl, pii_types, status)' +
          " values ($1, $2, $3, $4, $5, $6, $7, 'pending')" +
          ' on conflict (org_id, source, path) do update set' +
          ' content = excluded.content, content_hash = excluded.content_hash,' +
          ' acl = excluded.acl, pii_types = excluded.pii_types,' +
          " status = 'pending', updated_at = now()" +
          ' returning id, revision',
        [orgId, source, item.path, content, contentHash, JSON.stringify(acl), JSON.stringify(piiTypes)],
      )
      enqueued += 1
      // Enqueue after the row is committed by the surrounding block. The key
      // includes the hash so a re-upload of identical bytes is a no-op, and the
      // revision so that identical bytes uploaded *after* a deletion are not —
      // the chunks the earlier job produced are gone.
      toEnqueue.push([String(doc.id), `${contentHash}:${doc.revision}`])
    }

    // Mark deletions: previously known paths no longer present.
    let removed = 0
    for (const [path, row] of existing) {
      if (!incomingPaths.has(path) && row.status !== 'deleted') {
        // Clear the content, not just the status. The row stays as a tombstone
        // so a later resync can tell "gone" from "never seen", but keeping the
        // text meant a document the tenant deleted was still sitting in the
        // table, and storageUsage stops counting a deleted row, so those bytes
        // also vanished from the quota while staying on disk. Resync compares
        // content_hash, which is kept, so the tombstone still does its job.
        await conn.exec(
          "update documents set status = 'deleted', content = ''," +
            ' revision = revision + 1, updated_at = now() where id = $1',
          [row.id],
        )
        await conn.exec('delete from chunks where document_id = $1', [row.id])
        removed += 1
      }
    }
    return removed
  })

  // Enqueue outside the document transaction so a job is never queued for a
  // write that rolled back.
  for (const [docId, contentHash] of toEnqueue) {
    await jobs.enqueue(
      orgId,
      'ingest_document',
      { document_id: docId },
      `ingest:${docId}:${contentHash}`,
    )
  }

  return { enqueued, unchanged, deleted }
}

/**
 * Worker side: chunk and embed one document, replacing its chunks. Throws on
 * failure so the queue can retry and eventually dead-letter.
 */
export async function processIngestDocument(
  orgId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const documentId = String(payload.document_id)
  const doc = await connect(orgId, (conn) =>
    conn.one<{ id: string; content: string; status: string; acl: string[] }>(
      'select id, content, status, acl from documents where id = $1 and org_id = $2',
      [documentId, orgId],
    ),
  )
  if (doc === null || doc.status === 'deleted') {
    return // nothing to do; the document was removed before we ran
  }

  const texts = chunkText(doc.content)
  const embeddings = texts.length > 0 ? await getEmbedder().embedDocuments(texts) : []

  // A short embedding list would otherwise truncate silently, and the document
  // would be marked ingested holding a subset of its chunks. That is a permanent,
  // invisible hole in retrieval for that document, and nothing downstream would
  // ever see a reason to retry. Throwing sends it back through the queue and
  // eventually dead-letters it visibly. (Python gets this from zip(strict=True);
  // JavaScript's zip-by-index would just produce undefined.)
  if (embeddings.length !== texts.length) {
    throw new Error(
      `embedder returned ${embeddings.length} vectors for ${texts.length} chunks`,
    )
  }

  await connect(orgId, async (conn) => {
    await conn.exec('delete from chunks where document_id = $1', [documentId])
    if (texts.length > 0) {
      // One round trip rather than one per chunk. COPY would be faster still and
      // is not available: RLS forbids it.
      //
      // acl is denormalized from the parent document so that access-scoped vector
      // search can filter and order on the same relation (see migration 0010).
      // updateDocumentAcl keeps the copies in sync.
      const values: unknown[] = []
      const tuples: string[] = []
      const acl = JSON.stringify(doc.acl)
      // Zipped by index, which the length check above is what makes safe.
      for (const [ordinal, embedding] of embeddings.entries()) {
        const base = values.length
        values.push(orgId, documentId, ordinal, texts[ordinal], pgvector.toSql(embedding), acl)
        tuples.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
        )
      }
      await conn.exec(
        'insert into chunks(org_id, document_id, ordinal, text, embedding, acl) values ' +
          tuples.join(', '),
        values,
      )
    }
    await conn.exec(
      "update documents set status = 'ingested', updated_at = now() where id = $1",
      [documentId],
    )
  })
}

const DISPATCH: Record<string, (orgId: string, payload: Record<string, unknown>) => Promise<void>> =
  {
    ingest_document: processIngestDocument,
  }

export interface RunCounts {
  processed: number
  succeeded: number
  requeued: number
  dead: number
}

/**
 * Drain due jobs until the queue is empty or `maxJobs` is reached. This is the
 * worker's inner step, and stands in for a running worker in tests.
 */
export async function runPending(maxJobs = 1000): Promise<RunCounts> {
  const counts: RunCounts = { processed: 0, succeeded: 0, requeued: 0, dead: 0 }
  for (let i = 0; i < maxJobs; i++) {
    const job = await jobs.claimOne()
    if (job === null) break
    counts.processed += 1
    const handler = DISPATCH[job.kind]
    try {
      if (handler === undefined) throw new Error(`no handler for job kind: ${job.kind}`)
      await handler(String(job.org_id), job.payload)
      await jobs.markSucceeded(String(job.id))
      counts.succeeded += 1
    } catch (err) {
      // The queue is the safety net: any failure is recorded and retried.
      const outcome = await jobs.markFailed(String(job.id), describe(err))
      if (outcome === 'dead') {
        counts.dead += 1
        if (job.kind === 'ingest_document') {
          await markDocumentFailed(String(job.org_id), String(job.payload.document_id))
        }
      } else {
        counts.requeued += 1
      }
    }
  }
  return counts
}

/** Python's `repr(exc)`, near enough: the class name and the message. */
function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}(${JSON.stringify(err.message)})`
  return String(err)
}

async function markDocumentFailed(orgId: string, documentId: string): Promise<void> {
  await connect(orgId, (conn) =>
    conn.exec(
      "update documents set status = 'failed', updated_at = now() where id = $1 and org_id = $2",
      [documentId, orgId],
    ),
  )
}
