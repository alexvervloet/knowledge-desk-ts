/**
 * Plain-SQL migration runner. Applies every `migrations/NNNN_*.sql` not yet
 * recorded in `schema_migrations`, in filename order, each in its own transaction.
 *
 *     npm run migrate            # apply pending
 *     npm run migrate -- --status # list applied vs pending
 */

import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { settings } from './config.ts'

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/** A Postgres identifier, quoted. Identifiers cannot be parameterized. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** A Postgres string literal, quoted. Same reason as above, for the password. */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Make the database agree with APP_DATABASE_URL about the app role.
 *
 * The app connects as a least-privilege role so row-level security applies to
 * it (an owner or superuser bypasses RLS). That role has to exist with the
 * right password, and the credential belongs in exactly one place: the
 * APP_DATABASE_URL secret. Creating it here, from that URL, means a production
 * database never inherits the throwaway password migration 0007 falls back to
 * when nobody has provisioned the role.
 *
 * Idempotent, and a no-op when the app and owner URLs share a user, which is
 * how a single-role setup is expressed. Returns the role name, or null.
 */
export async function ensureAppRole(): Promise<string | null> {
  const app = new URL(settings.appDatabaseUrl)
  const owner = new URL(settings.databaseUrl)
  const role = decodeURIComponent(app.username)
  const password = decodeURIComponent(app.password)
  if (!role || role === decodeURIComponent(owner.username)) return null

  const client = new pg.Client({ connectionString: settings.databaseUrl })
  await client.connect()
  try {
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [role])
    const verb = exists.rowCount ? 'alter' : 'create'
    await client.query(`${verb} role ${quoteIdent(role)} login password ${quoteLiteral(password)}`)
  } finally {
    await client.end()
  }
  return role
}

function files(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f))
}

function version(path: string): string {
  return basename(path, '.sql')
}

async function ensureTable(client: pg.Client): Promise<void> {
  await client.query(
    'create table if not exists schema_migrations (' +
      '  version text primary key,' +
      '  applied_at timestamptz not null default now())',
  )
}

async function applied(client: pg.Client): Promise<Set<string>> {
  const result = await client.query<{ version: string }>('select version from schema_migrations')
  return new Set(result.rows.map((r) => r.version))
}

/** Apply pending migrations; return the versions applied this run. */
export async function applyPending(): Promise<string[]> {
  const appliedNow: string[] = []
  const role = await ensureAppRole()
  if (role) console.log(`  app role ${role} present with the configured password`)

  const client = new pg.Client({ connectionString: settings.databaseUrl })
  await client.connect()
  try {
    await ensureTable(client)
    const done = await applied(client)
    for (const path of files()) {
      const v = version(path)
      if (done.has(v)) continue
      const sqlText = readFileSync(path, 'utf8')
      await client.query('begin')
      try {
        // A versioned file from this repo, not user input. It is the one query
        // here assembled at runtime, and it says so.
        await client.query(sqlText)
        await client.query('insert into schema_migrations(version) values ($1)', [v])
        await client.query('commit')
      } catch (err) {
        await client.query('rollback').catch(() => {})
        throw err
      }
      console.log(`  applied ${v}`)
      appliedNow.push(v)
    }
  } finally {
    await client.end()
  }
  if (appliedNow.length === 0) console.log('  (no pending migrations)')
  return appliedNow
}

export async function status(): Promise<void> {
  const client = new pg.Client({ connectionString: settings.databaseUrl })
  await client.connect()
  let done: Set<string>
  try {
    await ensureTable(client)
    done = await applied(client)
  } finally {
    await client.end()
  }
  for (const path of files()) {
    const v = version(path)
    console.log(`  ${(done.has(v) ? 'applied' : 'PENDING').padEnd(8)} ${v}`)
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--status')) {
    await status()
  } else {
    console.log('migrating')
    await applyPending()
  }
  return 0
}

// Only when run as a script, not when a test imports applyPending.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
