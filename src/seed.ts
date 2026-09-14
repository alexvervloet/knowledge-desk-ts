/**
 * Seed two demo tenants so a reviewer can see both access boundaries live.
 *
 * Between orgs: neither org's questions can retrieve the other's content.
 *
 * Within one org: each org gets a group, an owner who is in it, and a second
 * member who is not. A document restricted to that group is readable by the owner
 * and not by the member, so the same question asked by two people in the same
 * organization returns different answers. Tenant isolation alone cannot show
 * that, and it is the harder half of the boundary to get right.
 *
 *     npm run seed
 *     npm run seed -- --reset    # rebuild the demo data first
 *
 * Idempotent: an org that already exists is left alone. Prints the demo logins.
 *
 * `--reset` exists because running the test suite destroys this data. The test
 * fixture truncates every domain table, and whichever test ran last leaves its
 * own org and users behind, so a plain re-seed then skips on the slug and the
 * demo logins stay broken. It removes only the two demo slugs and the accounts
 * under the two demo email domains, so it is safe to run against a development
 * database and pointless against any other.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import * as accounts from './accounts.ts'
import { closePool, connect } from './db.ts'
import * as ingest from './ingest.ts'
import { ORGS } from './seed-corpus.ts'
import { TenantScope } from './tenancy.ts'

/** The demo login for a throwaway local dataset, not a real credential. */
export const DEMO_PASSWORD = 'demo-password-123'

/** Remove the demo orgs and any account in the demo email domains. */
export async function reset(): Promise<void> {
  await connect(null, async (conn) => {
    for (const spec of ORGS) {
      const row = await conn.one<{ id: string }>('select id from orgs where slug = $1', [spec.slug])
      if (row) {
        // Deleting the org cascades to its documents, chunks and memberships.
        // Users are not org-scoped, so they outlive it and have to go separately
        // or the next signup collides on the email.
        await conn.exec('delete from orgs where id = $1', [row.id])
        console.log(`  removed org ${spec.slug}`)
      }
    }
    let removed = 0
    for (const spec of ORGS) {
      removed += await conn.exec('delete from users where email like $1', [`%@${spec.slug}.test`])
    }
    console.log(`  removed ${removed} demo accounts`)
  })
}

async function orgExists(slug: string): Promise<boolean> {
  const row = await connect(null, (conn) => conn.one('select 1 from orgs where slug = $1', [slug]))
  return row !== null
}

export async function seed(): Promise<void> {
  for (const spec of ORGS) {
    if (await orgExists(spec.slug)) {
      console.log(`  skip ${spec.slug} (already exists)`)
      continue
    }

    const ctx = await accounts.createOrgWithOwner(spec.slug, spec.name, spec.owner, DEMO_PASSWORD)
    const scope = new TenantScope(ctx)

    // The owner is in the restricted group; the second member is not. The ACL
    // principal is `group:<id>`, and the id only exists once the group is
    // created, so the group has to come before the documents that reference it.
    const group = await scope.createGroup(spec.group)
    await scope.addGroupMember(String(group.id), ctx.userId)

    await accounts.addMember(ctx.orgId, spec.member, DEMO_PASSWORD, 'member')

    const docs = spec.documents.map((d) => ({
      path: d.path,
      content: d.content,
      acl: d.group ? [`group:${String(group.id)}`] : ['public-to-org'],
    }))
    await ingest.syncDocuments(ctx.orgId, 'local-folder', docs)
    const restricted = spec.documents.filter((d) => d.group).length
    console.log(
      `  seeded ${spec.slug} with ${docs.length} documents` +
        ` (${restricted} restricted to group ${spec.group})`,
    )
  }

  const processed = await ingest.runPending()
  console.log(`  ingested: ${JSON.stringify(processed)}`)
  console.log(`\ndemo logins (password: ${DEMO_PASSWORD}):`)
  for (const spec of ORGS) {
    console.log(
      `  org=${spec.slug.padEnd(8)} ${spec.owner.padEnd(22)} in ${spec.group}, sees everything`,
    )
    console.log(
      `  org=${spec.slug.padEnd(8)} ${spec.member.padEnd(22)} not in the group, sees less`,
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--reset')) await reset()
    await seed()
  } finally {
    // A short-lived process has to close the pool itself, or node keeps the
    // event loop alive on idle connections and the command never exits.
    await closePool()
  }
}
