/**
 * Runtime configuration, loaded from the environment (and .env for local dev).
 *
 * Provider selection is derived, not configured: with no keys the app runs in the
 * loud mock fallback so it works and tests green with zero setup. PROVIDER_STRICT=1
 * turns the fallback into a hard startup error instead.
 *
 * Node 22 loads `.env` itself with `--env-file`, but only if you remember the flag,
 * and a test runner spawned by vitest never does. `loadDotEnv` below reads the file
 * the way pydantic-settings does: present values win, so a real environment
 * variable is never overwritten by the file.
 */

import { readFileSync } from 'node:fs'

function loadDotEnv(path = '.env'): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return // no .env is the normal case in CI and in the container
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] ??= value
  }
}

loadDotEnv()

function str(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function optional(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

function int(name: string, fallback: number): number {
  const raw = optional(name)
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer, got ${raw}`)
  return parsed
}

function float(name: string, fallback: number): number {
  const raw = optional(name)
  if (raw === undefined) return fallback
  const parsed = Number.parseFloat(raw)
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a number, got ${raw}`)
  return parsed
}

function bool(name: string, fallback: boolean): boolean {
  const raw = optional(name)?.toLowerCase()
  if (raw === undefined) return fallback
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function list(name: string, fallback: string[]): string[] {
  const raw = optional(name)
  if (raw === undefined) return fallback
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

type SettingsData = Omit<Settings, 'provider'>

export interface Settings {
  databaseUrl: string
  appDatabaseUrl: string
  dbPoolMin: number
  dbPoolMax: number
  anthropicApiKey: string | undefined
  voyageApiKey: string | undefined
  providerStrict: boolean
  sessionTtlHours: number
  corsOrigins: string[]
  serveStatic: boolean
  staticDir: string
  embedModel: string
  chunkSize: number
  chunkOverlap: number
  jobMaxAttempts: number
  jobStaleAfterSeconds: number
  drainInProcess: boolean
  answerModel: string
  answerMaxTokens: number
  retrievalK: number
  dailyBudgetUsd: number
  platformDailyBudgetUsd: number
  monthlyQuestionCap: number
  rateBurst: number
  ratePerMin: number
  authRateBurst: number
  authRatePerMin: number
  clientIpHeader: string | undefined
  orgDocCap: number
  orgStorageBytesCap: number
  maxRequestBytes: number
  /** "real" only when both keys are present; otherwise the mock fallback. */
  readonly provider: string
}

function build(): SettingsData {
  const s = {
    // Owner role: migrations, DDL, and preflight. Superuser in dev.
    databaseUrl: str('DATABASE_URL', 'postgresql://kd:kd@localhost:5437/knowledge_desk'),
    // Least-privilege app role: every runtime query. Non-owner so RLS applies.
    appDatabaseUrl: str('APP_DATABASE_URL', 'postgresql://kd_app:kd_app@localhost:5437/knowledge_desk'),

    // Connection pool bounds. Keep max at or below the database's connection
    // limit divided by the number of running processes.
    dbPoolMin: int('DB_POOL_MIN', 1),
    dbPoolMax: int('DB_POOL_MAX', 10),

    anthropicApiKey: optional('ANTHROPIC_API_KEY'),
    voyageApiKey: optional('VOYAGE_API_KEY'),

    // When true, refuse to start in mock mode instead of falling back loudly.
    providerStrict: bool('PROVIDER_STRICT', false),

    // How long a login session stays valid.
    sessionTtlHours: int('SESSION_TTL_HOURS', 720),

    // Frontend dev server origins allowed to call the API cross-origin. In prod
    // the UI is served same-origin from the API, so this only matters for `npm run dev`.
    corsOrigins: list('CORS_ORIGINS', ['http://localhost:5173']),

    // Serve the built SPA from the API (same-origin) in the container. Off by
    // default so dev and tests do not depend on a built frontend.
    serveStatic: bool('SERVE_STATIC', false),
    staticDir: str('STATIC_DIR', 'frontend/dist'),

    // Ingestion.
    embedModel: str('EMBED_MODEL', 'voyage-3'),
    chunkSize: int('CHUNK_SIZE', 1000),
    chunkOverlap: int('CHUNK_OVERLAP', 150),
    jobMaxAttempts: int('JOB_MAX_ATTEMPTS', 3),
    // A job still `running` this long after its claim lost its process (the
    // machine stopped mid-embed) and is handed out again. One document embeds
    // in seconds, so ten minutes cannot catch a job that is merely slow.
    jobStaleAfterSeconds: int('JOB_STALE_AFTER_SECONDS', 600),
    // The server drains the queue in the background (worker.kick). The test
    // suite turns this off and drains by calling runPending itself, so a
    // background drain cannot take a job out from under the test asserting on it.
    drainInProcess: bool('DRAIN_IN_PROCESS', true),

    // Assistant.
    //
    // Sonnet rather than Opus 5, and not for cost. `claude-opus-5` returns
    // `stop_reason: refusal` with category `reasoning_extraction` on this app's
    // system prompt, so every answer comes back empty. The prompt is not the
    // problem: Sonnet 5, Haiku 4.5 and Opus 4.8 all answer the identical prompt
    // and cite correctly. Bisecting it showed the refusal is cumulative rather
    // than one sentence, and holds with the fence paragraph removed entirely,
    // so there is no wording fix that keeps the defence intact.
    //
    // Sonnet also costs $2/$10 per MTok against $5/$25. See LESSONS.md.
    answerModel: str('ANSWER_MODEL', 'claude-sonnet-5'),
    answerMaxTokens: int('ANSWER_MAX_TOKENS', 2048),
    retrievalK: int('RETRIEVAL_K', 6),

    // Operational controls (all env-overridable).
    dailyBudgetUsd: float('DAILY_BUDGET_USD', 5.0), // per org, rolling 24h
    // Across every org, calendar day. The per-org caps bound one tenant; this is
    // the only number that bounds the bill, since signup creates tenants freely.
    platformDailyBudgetUsd: float('PLATFORM_DAILY_BUDGET_USD', 25.0),
    monthlyQuestionCap: int('MONTHLY_QUESTION_CAP', 1000), // per org, calendar month
    rateBurst: int('RATE_BURST', 5), // per user, token-bucket burst
    ratePerMin: int('RATE_PER_MIN', 30), // per user, sustained
    authRateBurst: int('AUTH_RATE_BURST', 10), // per client IP, on login and signup
    authRatePerMin: int('AUTH_RATE_PER_MIN', 10), // per client IP, sustained

    // Header carrying the real client IP when the app sits behind a proxy that
    // sets it (Fly-Client-IP on Fly). Unset means trust the socket peer, which is
    // right locally and wrong behind a proxy, where every caller would otherwise
    // share the proxy's bucket. Only set this to a header the proxy overwrites on
    // the way in; one a client can supply itself is a limiter that bypasses
    // itself.
    clientIpHeader: optional('CLIENT_IP_HEADER'),
    orgDocCap: int('ORG_DOC_CAP', 1000), // per org, total documents
    orgStorageBytesCap: int('ORG_STORAGE_BYTES_CAP', 50_000_000), // per org, total content bytes

    // Hard ceiling on a single request body, enforced before the body is read.
    // The org caps above are the policy; this is what stops a request that will
    // fail them from costing the memory to find out. Uploads past this have to
    // be split into batches.
    maxRequestBytes: int('MAX_REQUEST_BYTES', 16_000_000),
  }

  return s
}

export const settings: Settings = Object.defineProperty(build(), 'provider', {
  // A getter rather than a field, because it is derived from two other fields a
  // test may reassign at any point. A value computed once at import would go
  // stale the moment a test set a key, and would then report "mock" while the
  // real provider was in use.
  get(this: SettingsData): string {
    return this.anthropicApiKey && this.voyageApiKey ? 'real' : 'mock'
  },
  enumerable: true,
}) as Settings

/**
 * Re-read the environment into `settings` in place.
 *
 * The Python side builds `Settings()` once at import and tests reach in with
 * monkeypatch.setattr. Tests here do the same by assigning to fields, but a test
 * that wants to change an env var needs this to see it. Exported for tests only;
 * nothing in the running app calls it.
 */
export function reloadSettings(): void {
  Object.assign(settings, build())
}
