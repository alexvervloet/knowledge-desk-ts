/**
 * Background worker: drain the job queue, then wait and repeat. Runs as its own
 * process alongside the API (a second service in compose and in the deploy).
 *
 *     npm run worker            # loop forever
 *     npm run worker -- --once  # drain once and exit
 *
 * Idempotent and safe to run more than one at a time: claims use SKIP LOCKED.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { purgeExpiredSessions } from './accounts.ts'
import { closePool } from './db.ts'
import { runPending } from './ingest.ts'

const POLL_SECONDS = 2.0
// Expired sessions are refused on sight, so sweeping them is housekeeping and an
// hour of staleness costs nothing. The worker is the process already awake on a
// timer, which is the only reason this lives here.
const SESSION_PURGE_SECONDS = 3600.0

export async function loop(once = false): Promise<void> {
  let nextPurge = 0
  for (;;) {
    const counts = await runPending()
    if (counts.processed) {
      console.log(
        `processed=${counts.processed} succeeded=${counts.succeeded}` +
          ` requeued=${counts.requeued} dead=${counts.dead}`,
      )
    }
    const now = performance.now() / 1000
    if (now >= nextPurge) {
      const purged = await purgeExpiredSessions()
      if (purged) console.log(`purged ${purged} expired session(s)`)
      nextPurge = now + SESSION_PURGE_SECONDS
    }
    if (once) return
    await sleep(POLL_SECONDS * 1000)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const once = process.argv.includes('--once')
  // SIGTERM is how compose and the deploy stop this process. Without a handler
  // node exits immediately and a job claimed a moment ago stays 'running' until
  // its lock expires; draining the current pass first lets it finish or fail
  // honestly.
  let stopping = false
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(1) // a second signal means they meant it
      stopping = true
      console.log(`${signal} received, finishing the current pass`)
    })
  }
  try {
    await loop(once)
  } finally {
    await closePool()
  }
}
