/**
 * The tenant-scoped data layer.
 *
 * Every org-scoped read and write goes through TenantScope, which carries the
 * acting user's orgId and stamps it onto every query. This is the single choke
 * point that makes cross-tenant leakage a code-review target instead of something
 * spread across every handler: if a query touches org data and is not a method
 * here, that is the bug.
 */

import pgvector from 'pgvector/pg'
import { purgeStrandedUsers } from './accounts.ts'
import { roleAtLeast } from './auth.ts'
import { settings } from './config.ts'
import { connect, isUniqueViolation, type Conn, type Row } from './db.ts'
import { Conflict, Forbidden, NotFound, QuotaExceeded } from './errors.ts'
import { round6 } from './numbers.ts'
import { syncDocuments, type UploadItem } from './ingest.ts'

// Rows per round trip when sweeping a listing for the export. Not the API's page
// cap, which bounds what a client may ask for; this is an internal loop, so the
// number only trades round trips against peak memory.
export const SWEEP_PAGE = 500

/**
 * Collect every row of a paginated listing.
 *
 * export() used to call the list methods with no arguments and inherit whatever
 * their limit defaulted to. That was fine until pagination landed and the default
 * became 100, at which point a tenant's export silently stopped at 100 members
 * and 100 documents: well-formed JSON, quietly incomplete, which is the worst way
 * for a data-export to fail. Paging explicitly here means the listing defaults
 * can move again without taking the export with them.
 *
 * A standalone function rather than a method, because the loop has one property
 * worth testing on its own — that it terminates on a row count which is an exact
 * multiple of the page size, rather than dropping the final page or spinning
 * forever — and testing that through a tenant with 500 documents would be slow
 * enough that nobody would run it.
 */
export async function sweepPages<T>(
  fetch: (limit: number, offset: number) => Promise<T[]>,
  pageSize: number = SWEEP_PAGE,
): Promise<T[]> {
  const rows: T[] = []
  for (;;) {
    const page = await fetch(pageSize, rows.length)
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

/** Who is acting, and in which org. Built from a resolved session. */
export interface AuthContext {
  readonly userId: string
  readonly orgId: string
  readonly role: string
  readonly email: string
}

export interface SyncResult {
  enqueued: number
  unchanged: number
  deleted: number
}

export class TenantScope {
  readonly ctx: AuthContext

  constructor(ctx: AuthContext) {
    this.ctx = ctx
  }

  get orgId(): string {
    return this.ctx.orgId
  }

  requireRole(minimum: string): void {
    if (!roleAtLeast(this.ctx.role, minimum)) {
      throw new Forbidden(`requires role ${minimum}, caller is ${this.ctx.role}`)
    }
  }

  /**
   * Gate a role assignment: admin or better, and never a role above the
   * caller's own rank.
   *
   * Handing out a role you do not hold is privilege escalation with an extra
   * step. An admin who can create an owner also picks that account's password,
   * so they log in as it and hold every owner power, including the irreversible
   * `DELETE /org`. The rank ceiling is what makes "admins manage members, owners
   * manage ownership" true at the API and not just in the UI.
   */
  requireCanGrant(role: string): void {
    this.requireRole('admin')
    if (!roleAtLeast(this.ctx.role, role)) {
      throw new Forbidden(`cannot grant role ${role}, caller is ${this.ctx.role}`)
    }
  }

  // --- groups -----------------------------------------------------------

  listGroups(): Promise<Row[]> {
    return connect(this.orgId, (conn) =>
      conn.query(
        'select id, name, created_at from groups where org_id = $1 order by name',
        [this.orgId],
      ),
    )
  }

  async createGroup(name: string): Promise<Row> {
    this.requireRole('admin')
    try {
      return await connect(this.orgId, (conn) =>
        conn.require(
          'insert into groups(org_id, name) values ($1, $2)' + ' returning id, name, created_at',
          [this.orgId, name],
        ),
      )
    } catch (err) {
      if (isUniqueViolation(err)) throw new Conflict(`group already exists: ${name}`)
      throw err
    }
  }

  /**
   * Fetch a group by id, but only within the caller's org. A group that belongs
   * to another org is indistinguishable from one that does not exist: the org_id
   * filter is the isolation boundary.
   */
  async getGroup(groupId: string): Promise<Row> {
    const row = await connect(this.orgId, (conn) =>
      conn.one(
        'select id, name, created_at from groups where id = $1 and org_id = $2',
        [groupId, this.orgId],
      ),
    )
    if (row === null) throw new NotFound(`group not found: ${groupId}`)
    return row
  }

  /**
   * Add an org member to a group, addressed by email. Returns the user id.
   *
   * The resolution happens inside the org, and that is the whole point. The
   * route used to resolve the email globally and then let this class check
   * membership, which produced two tellable-apart 404s: "no user with email"
   * when the address had no account anywhere, "user is not a member of this
   * org" when it had one in someone else's tenant. An org admin could walk a
   * list of addresses and learn which of them have accounts on the platform.
   * Scoping the lookup means both cases give the same answer.
   */
  async addGroupMemberByEmail(groupId: string, email: string): Promise<string> {
    this.requireRole('admin')
    const row = await connect(this.orgId, (conn) =>
      conn.one(
        'select u.id from users u join memberships m on m.user_id = u.id' +
          ' where u.email = $1 and m.org_id = $2',
        [email.trim().toLowerCase(), this.orgId],
      ),
    )
    if (row === null) throw new NotFound(`no member of this org with email: ${email}`)
    const userId = String(row.id)
    await this.addGroupMember(groupId, userId)
    return userId
  }

  async addGroupMember(groupId: string, userId: string): Promise<void> {
    this.requireRole('admin')
    await this.getGroup(groupId) // 404s if the group is not in this org
    await connect(this.orgId, async (conn) => {
      const isMember = await conn.one(
        'select 1 from memberships where user_id = $1 and org_id = $2',
        [userId, this.orgId],
      )
      if (isMember === null) {
        // Cannot add a user to a group unless they belong to this org.
        throw new NotFound(`user is not a member of this org: ${userId}`)
      }
      await conn.exec(
        'insert into group_members(group_id, user_id) values ($1, $2) on conflict do nothing',
        [groupId, userId],
      )
    })
  }

  async removeGroupMember(groupId: string, userId: string): Promise<void> {
    this.requireRole('admin')
    await this.getGroup(groupId) // 404s if the group is not in this org
    await connect(this.orgId, (conn) =>
      conn.exec('delete from group_members where group_id = $1 and user_id = $2', [groupId, userId]),
    )
  }

  async listGroupMembers(groupId: string): Promise<Row[]> {
    await this.getGroup(groupId)
    return connect(this.orgId, (conn) =>
      conn.query(
        'select u.id, u.email from group_members gm' +
          ' join users u on u.id = gm.user_id' +
          ' where gm.group_id = $1 order by u.email',
        [groupId],
      ),
    )
  }

  async deleteGroup(groupId: string): Promise<void> {
    this.requireRole('admin')
    const row = await connect(this.orgId, (conn) =>
      conn.one('delete from groups where id = $1 and org_id = $2 returning id', [
        groupId,
        this.orgId,
      ]),
    )
    if (row === null) throw new NotFound(`group not found: ${groupId}`)
  }

  // --- members ----------------------------------------------------------

  private async ownerCount(conn: Conn): Promise<number> {
    const row = await conn.require<{ n: string }>(
      "select count(*) as n from memberships where org_id = $1 and role = 'owner'",
      [this.orgId],
    )
    // count(*) comes back as a bigint, which node-postgres hands over as a
    // string so a value past 2^53 is not silently mangled. Ours never is.
    return Number(row.n)
  }

  /**
   * Change a member's role. You cannot change your own role (avoids
   * self-lockout), you cannot grant a role above your own, and the org must
   * always keep at least one owner.
   */
  async setMemberRole(userId: string, role: string): Promise<void> {
    this.requireCanGrant(role)
    if (userId === this.ctx.userId) throw new Forbidden('you cannot change your own role')
    await connect(this.orgId, async (conn) => {
      const target = await conn.one<{ role: string }>(
        'select role from memberships where user_id = $1 and org_id = $2',
        [userId, this.orgId],
      )
      if (target === null) throw new NotFound(`member not found: ${userId}`)
      if (target.role === 'owner' && role !== 'owner' && (await this.ownerCount(conn)) === 1) {
        throw new Forbidden('the org must keep at least one owner')
      }
      await conn.exec('update memberships set role = $1 where user_id = $2 and org_id = $3', [
        role,
        userId,
        this.orgId,
      ])
    })
  }

  /**
   * Remove a member from the org. You cannot remove yourself, and you cannot
   * remove the last owner.
   */
  async removeMember(userId: string): Promise<void> {
    this.requireRole('admin')
    if (userId === this.ctx.userId) throw new Forbidden('you cannot remove yourself')
    await connect(this.orgId, async (conn) => {
      const target = await conn.one<{ role: string }>(
        'select role from memberships where user_id = $1 and org_id = $2',
        [userId, this.orgId],
      )
      if (target === null) throw new NotFound(`member not found: ${userId}`)
      if (target.role === 'owner' && (await this.ownerCount(conn)) === 1) {
        throw new Forbidden('cannot remove the last owner')
      }
      await conn.exec('delete from memberships where user_id = $1 and org_id = $2', [
        userId,
        this.orgId,
      ])
      // Removing someone from their only org strands the user row: no membership
      // means no way to log in, while the email stays taken for good.
      await purgeStrandedUsers(conn, [userId])
    })
  }

  // --- documents --------------------------------------------------------

  /**
   * Reconcile one source's documents for this org, enforcing the storage caps
   * first. Admin only.
   *
   * The caps live here rather than in the route because they are a property of
   * the tenant, and because this is the layer a new caller reaches for.
   * Conservative on updates: an edit counts toward the incoming total, which can
   * only over-protect.
   */
  syncSource(source: string, items: UploadItem[]): Promise<SyncResult> {
    this.requireRole('admin')
    const incomingBytes = items.reduce((n, i) => n + Buffer.byteLength(i.content, 'utf8'), 0)

    /**
     * Runs inside the transaction that does the writing.
     *
     * Reading usage and then writing in a separate transaction let two
     * concurrent uploads each see room that only one of them could have, and
     * both pass a cap neither should have. Locking the org row holds the answer
     * still until the documents land. Serializing on the tenant is cheap here:
     * uploads are rare and already slow.
     */
    const checkCaps = async (conn: Conn): Promise<void> => {
      await conn.exec('select 1 from orgs where id = $1 for update', [this.orgId])
      const usage = await conn.require<{ docs: string; bytes: string }>(
        'select count(*) as docs,' +
          ' coalesce(sum(octet_length(content)), 0) as bytes' +
          " from documents where org_id = $1 and status <> 'deleted'",
        [this.orgId],
      )
      if (Number(usage.bytes) + incomingBytes > settings.orgStorageBytesCap) {
        throw new QuotaExceeded('org storage cap exceeded')
      }
      if (Number(usage.docs) + items.length > settings.orgDocCap) {
        throw new QuotaExceeded('org document cap exceeded')
      }
    }

    return syncDocuments(this.orgId, source, items, checkCaps)
  }

  /**
   * Total documents in the org, for the X-Total-Count header. A separate query
   * rather than a window function over the page, because the page is capped and
   * the client needs the count of everything, not of the page.
   */
  async countDocuments(): Promise<number> {
    const row = await connect(this.orgId, (conn) =>
      conn.require<{ n: string }>('select count(*) as n from documents where org_id = $1', [
        this.orgId,
      ]),
    )
    return Number(row.n)
  }

  listDocuments(limit = 100, offset = 0): Promise<Row[]> {
    // Open to every member on purpose: seeing which documents the org holds is
    // not the same as being able to read them, and the Sources tab is for
    // everyone. Retrieval is what enforces the ACL, per document.
    return connect(this.orgId, (conn) =>
      conn.query(
        'select d.id, d.path, d.source, d.status, d.content_hash,' +
          ' d.pii_types, d.acl, d.updated_at,' +
          ' (select count(*) from chunks c where c.document_id = d.id)' +
          ' as chunk_count' +
          ' from documents d where d.org_id = $1 order by d.path' +
          ' limit $2 offset $3',
        [this.orgId, limit, offset],
      ),
    )
  }

  /**
   * One document with its text, but only if this caller may read it.
   *
   * Unlike `listDocuments`, which is open to every member because knowing a
   * document exists is not reading it, this returns content and so is gated by
   * the same ACL predicate retrieval uses. The check is part of the query rather
   * than a test on the fetched row: a post-filter is one forgotten `if` away
   * from returning the content it was meant to withhold.
   *
   * A document that is out of scope raises NotFound, not Forbidden. That is
   * deliberate and matches the rest of this class: distinguishing the two
   * answers "does not exist" from "exists, not yours" would let anyone with an
   * id test whether a document exists.
   */
  async getDocument(documentId: string): Promise<Row> {
    const principals = await this.principals()
    const row = await connect(this.orgId, (conn) =>
      conn.one(
        'select d.id, d.path, d.status, d.updated_at,' +
          ' string_agg(c.text, $1 order by c.ordinal) as content,' +
          ' count(c.id) as chunk_count' +
          ' from documents d join chunks c on c.document_id = d.id' +
          " where d.id = $2 and d.org_id = $3 and d.status = 'ingested'" +
          ' and c.acl ?| $4::text[]' +
          ' group by d.id, d.path, d.status, d.updated_at',
        ['\n', documentId, this.orgId, principals],
      ),
    )
    if (row === null) throw new NotFound(`document not found: ${documentId}`)
    return row
  }

  /**
   * Delete a document and everything derived from it. Admin only. Chunks cascade
   * via the foreign key; the ACL lives on the document row, so it goes too.
   */
  async deleteDocument(documentId: string): Promise<void> {
    this.requireRole('admin')
    const row = await connect(this.orgId, (conn) =>
      conn.one('delete from documents where id = $1 and org_id = $2 returning id', [
        documentId,
        this.orgId,
      ]),
    )
    if (row === null) throw new NotFound(`document not found: ${documentId}`)
  }

  async updateDocumentAcl(documentId: string, acl: string[]): Promise<void> {
    this.requireRole('admin')
    await connect(this.orgId, async (conn) => {
      const row = await conn.one(
        'update documents set acl = $1, updated_at = now()' +
          ' where id = $2 and org_id = $3 returning id',
        [JSON.stringify(acl), documentId, this.orgId],
      )
      if (row === null) throw new NotFound(`document not found: ${documentId}`)
      // Chunks carry a denormalized copy so vector search can filter and order
      // on one relation; both writes share this transaction so an ACL change can
      // never be half applied.
      await conn.exec('update chunks set acl = $1 where document_id = $2 and org_id = $3', [
        JSON.stringify(acl),
        documentId,
        this.orgId,
      ])
    })
  }

  /**
   * A portable snapshot of the org's members and documents (metadata, not raw
   * content). Admin only. Backs the tenant data-export requirement.
   */
  async export(): Promise<{ members: Row[]; documents: Row[] }> {
    this.requireRole('admin')
    return {
      members: await this.sweep((l, o) => this.listMembers(l, o)),
      documents: await this.sweep((l, o) => this.listDocuments(l, o)),
    }
  }

  /**
   * A portable snapshot of the org's members and documents. See `sweepPages` for
   * why the listings are paged explicitly rather than called bare.
   */
  private sweep(fetch: (limit: number, offset: number) => Promise<Row[]>): Promise<Row[]> {
    return sweepPages(fetch)
  }

  // --- retrieval --------------------------------------------------------

  /**
   * The caller's access set: org-wide, their own user principal, and one
   * principal per group they belong to. Computed fresh on every call, so a group
   * change takes effect on the next query with no cache to invalidate.
   */
  async principals(): Promise<string[]> {
    const groups = await connect(this.orgId, (conn) =>
      conn.query<{ group_id: string }>(
        'select gm.group_id from group_members gm' +
          ' join groups g on g.id = gm.group_id' +
          ' where g.org_id = $1 and gm.user_id = $2',
        [this.orgId, this.ctx.userId],
      ),
    )
    return [
      'public-to-org',
      `user:${this.ctx.userId}`,
      ...groups.map((r) => `group:${r.group_id}`),
    ]
  }

  /**
   * How many ingested chunks the org has, and how many of them this caller is
   * allowed to see. The gap is the ACL filter made visible (used in the
   * retriever trace span). Two cheap counts, only computed when tracing.
   */
  async retrievalStats(): Promise<{ orgChunks: number; allowedChunks: number }> {
    const principals = await this.principals()
    return connect(this.orgId, async (conn) => {
      const orgChunks = await conn.require<{ n: string }>(
        'select count(*) as n from chunks c join documents d on d.id = c.document_id' +
          " where c.org_id = $1 and d.status = 'ingested'",
        [this.orgId],
      )
      const allowed = await conn.require<{ n: string }>(
        'select count(*) as n from chunks c join documents d on d.id = c.document_id' +
          " where c.org_id = $1 and d.status = 'ingested' and c.acl ?| $2::text[]",
        [this.orgId, principals],
      )
      return { orgChunks: Number(orgChunks.n), allowedChunks: Number(allowed.n) }
    })
  }

  /**
   * Nearest chunks the caller is allowed to see. The ACL filter is part of the
   * candidate fetch (`c.acl ?| principals`), so a forbidden chunk is never
   * ranked, never scored, and cannot leak through a missed post-filter. The
   * org_id filter sits on top as the tenant boundary.
   */
  async search(queryEmbedding: number[], k = 5): Promise<Row[]> {
    const principals = await this.principals()
    const vec = pgvector.toSql(queryEmbedding) // binds as `vector`, not double precision[]
    return connect(this.orgId, (conn) =>
      // The ACL predicate reads c.acl, not d.acl. Filtering on the joined
      // documents table forces the planner to abandon the HNSW index and sort
      // the whole corpus; keeping the filter on the same relation as the vector
      // keeps the index in play. See migration 0010.
      conn.query(
        'select c.document_id, c.ordinal, c.text, d.path,' +
          ' (c.embedding <=> $1) as distance' +
          ' from chunks c join documents d on d.id = c.document_id' +
          " where c.org_id = $2 and d.status = 'ingested'" +
          ' and c.acl ?| $3::text[]' +
          ' order by c.embedding <=> $1 limit $4',
        [vec, this.orgId, principals, k],
      ),
    )
  }

  // --- answers and feedback --------------------------------------------

  /**
   * Store a question and what answered it.
   *
   * The question text is stored as asked, unlike audit-log detail, which is
   * PII-redacted before it is written. The asymmetry is deliberate: an audit
   * entry is metadata about an action, where a stray email address is incidental
   * and redacting it costs nothing, while a question *is* the content —
   * redacting it would leave `topQueries` showing "[REDACTED-EMAIL]" and make an
   * answer impossible to trace back to what was asked. Anyone who can read these
   * is already an admin of the org the asker belongs to. It is worth knowing
   * that this is where user-typed text accumulates in the clear.
   */
  async recordAnswer(question: string, provider: string, refused: boolean): Promise<string> {
    const row = await connect(this.orgId, (conn) =>
      conn.require(
        'insert into answers(org_id, user_id, question, provider, refused)' +
          ' values ($1, $2, $3, $4, $5) returning id',
        [this.orgId, this.ctx.userId, question, provider, refused],
      ),
    )
    return String(row.id)
  }

  /**
   * Record what an answer consumed. `estimated` marks usage inferred from what
   * was streamed rather than reported by the provider, which is what a client
   * disconnect leaves behind (see assistant.answerStream).
   */
  async finalizeAnswer(
    answerId: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
    estimated = false,
  ): Promise<void> {
    await connect(this.orgId, async (conn) => {
      await conn.exec(
        'update answers set input_tokens = $1, output_tokens = $2,' +
          ' cost_usd = $3, usage_estimated = $4 where id = $5 and org_id = $6',
        [inputTokens, outputTokens, costUsd, estimated, answerId, this.orgId],
      )
      // Same transaction as the per-org ledger, so the two can never disagree
      // about whether an answer was paid for.
      await conn.exec(
        'insert into platform_spend(day, cost_usd) values (current_date, $1)' +
          ' on conflict (day) do update' +
          ' set cost_usd = platform_spend.cost_usd + excluded.cost_usd',
        [costUsd],
      )
    })
  }

  async markBlocked(answerId: string): Promise<void> {
    await connect(this.orgId, (conn) =>
      conn.exec('update answers set blocked = true where id = $1 and org_id = $2', [
        answerId,
        this.orgId,
      ]),
    )
  }

  async spendLast24h(): Promise<number> {
    const row = await connect(this.orgId, (conn) =>
      conn.require<{ spend: string }>(
        'select coalesce(sum(cost_usd), 0) as spend from answers' +
          " where org_id = $1 and created_at > now() - interval '24 hours'",
        [this.orgId],
      ),
    )
    return Number(row.spend)
  }

  /**
   * Today's spend across every tenant. Not org-scoped on purpose: it is the
   * ceiling on the whole deployment's bill, which per-org caps cannot provide
   * while signup is open (see migration 0013).
   */
  async platformSpendToday(): Promise<number> {
    const row = await connect(this.orgId, (conn) =>
      conn.one<{ cost_usd: string }>('select cost_usd from platform_spend where day = current_date'),
    )
    return row ? Number(row.cost_usd) : 0.0
  }

  async questionsThisMonth(): Promise<number> {
    const row = await connect(this.orgId, (conn) =>
      conn.require<{ n: string }>(
        'select count(*) as n from answers where org_id = $1' +
          " and created_at >= date_trunc('month', now())",
        [this.orgId],
      ),
    )
    return Number(row.n)
  }

  /**
   * Live document count and total content bytes for this org (excluding deleted
   * documents). Used to enforce ingest caps.
   */
  async storageUsage(): Promise<{ docs: number; bytes: number }> {
    const row = await connect(this.orgId, (conn) =>
      conn.require<{ docs: string; bytes: string }>(
        'select count(*) as docs,' +
          ' coalesce(sum(octet_length(content)), 0) as bytes' +
          " from documents where org_id = $1 and status <> 'deleted'",
        [this.orgId],
      ),
    )
    return { docs: Number(row.docs), bytes: Number(row.bytes) }
  }

  async countAudit(): Promise<number> {
    this.requireRole('admin')
    const row = await connect(this.orgId, (conn) =>
      conn.require<{ n: string }>('select count(*) as n from audit_log where org_id = $1', [
        this.orgId,
      ]),
    )
    return Number(row.n)
  }

  /** Recent audit events for this org. Admin only. */
  listAudit(limit = 100, offset = 0): Promise<Row[]> {
    this.requireRole('admin')
    return connect(this.orgId, (conn) =>
      conn.query(
        'select a.action, a.detail, a.created_at, u.email as actor' +
          ' from audit_log a left join users u on u.id = a.actor_user_id' +
          ' where a.org_id = $1 order by a.created_at desc' +
          ' limit $2 offset $3',
        [this.orgId, limit, offset],
      ),
    )
  }

  async topQueries(limit = 5): Promise<Array<{ question: string; count: number }>> {
    const rows = await connect(this.orgId, (conn) =>
      conn.query<{ question: string; count: string }>(
        'select question, count(*) as count from answers' +
          " where org_id = $1 and created_at >= date_trunc('month', now())" +
          ' group by question order by count desc, question limit $2',
        [this.orgId, limit],
      ),
    )
    return rows.map((r) => ({ question: r.question, count: Number(r.count) }))
  }

  /**
   * Everything the usage dashboard needs: volume and cost against their caps,
   * storage against its cap, and the month's top questions. Admin only.
   */
  async usageSummary(): Promise<Record<string, unknown>> {
    this.requireRole('admin')
    const storage = await this.storageUsage()
    return {
      questions: {
        used: await this.questionsThisMonth(),
        cap: settings.monthlyQuestionCap,
      },
      spend: {
        used_usd: round6(await this.spendLast24h()),
        budget_usd: settings.dailyBudgetUsd,
      },
      storage: {
        docs: storage.docs,
        doc_cap: settings.orgDocCap,
        bytes: storage.bytes,
        byte_cap: settings.orgStorageBytesCap,
      },
      top_queries: await this.topQueries(),
    }
  }

  async addFeedback(answerId: string, rating: string, note: string | null): Promise<void> {
    await connect(this.orgId, async (conn) => {
      const answer = await conn.one('select 1 from answers where id = $1 and org_id = $2', [
        answerId,
        this.orgId,
      ])
      if (answer === null) throw new NotFound(`answer not found: ${answerId}`)
      try {
        await conn.exec(
          'insert into feedback(org_id, user_id, answer_id, rating, note)' +
            ' values ($1, $2, $3, $4, $5)',
          [this.orgId, this.ctx.userId, answerId, rating, note],
        )
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new Conflict('feedback already recorded for this answer')
        }
        throw err
      }
    })
  }

  // --- members ----------------------------------------------------------

  async countMembers(): Promise<number> {
    const row = await connect(this.orgId, (conn) =>
      conn.require<{ n: string }>('select count(*) as n from memberships where org_id = $1', [
        this.orgId,
      ]),
    )
    return Number(row.n)
  }

  listMembers(limit = 100, offset = 0): Promise<Row[]> {
    return connect(this.orgId, (conn) =>
      conn.query(
        'select u.id, u.email, m.role, m.created_at' +
          ' from memberships m join users u on u.id = m.user_id' +
          ' where m.org_id = $1 order by u.email limit $2 offset $3',
        [this.orgId, limit, offset],
      ),
    )
  }
}
