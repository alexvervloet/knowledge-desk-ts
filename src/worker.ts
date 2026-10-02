/**
 * Drain the job queue while there is work, then stop.
 *
 * There is no always-on worker. One used to poll the jobs table every two
 * seconds, and on the Python side that query alone kept a scale-to-zero
 * database awake all month. It was the whole Neon bill for a demo nobody was
 * using (LESSONS.md, "A two-second poll keeps the database awake").
 *
 * Now the server calls `kick()` at startup and after every enqueue. A kick
 * starts one background drain, or wakes the one already running. The drain runs
 * due jobs, sleeps until the next retry falls due, and returns when no job is
 * waiting. An idle deployment sends no queries at all, so the machine can stop
 * and the database can suspend.
 *
 *     npm run worker            # drain until empty, then exit
 *     npm run worker -- --once  # one pass over due jobs, then exit
 *
 * Safe to run alongside another drain (a second machine, a manual run): claims
 * use SKIP LOCKED.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { purgeExpiredSessions } from './accounts.ts'
import { settings } from './config.ts'
import { closePool } from './db.ts'
import { runPending } from './ingest.ts'
import { secondsUntilDue } from './jobs.ts'

// One drain per process. The Python side needs a lock to make "the queue is
// empty, so stop" and "start a drain" one decision each. Here the event loop
// gives that for free, provided `running` is cleared in the same synchronous
// step that decides to stop, which is what `onIdle` is for.
let running: Promise<void> | null = null
let kicked = false
let wake: (() => void) | null = null

async function loop(once: boolean, onIdle?: () => void): Promise<void> {
  // Expired sessions are swept once per drain. resolveSession refuses them on
  // sight, so the sweep is housekeeping and can wait for the next upload or the
  // next cold start.
  const purged = await purgeExpiredSessions()
  if (purged) console.log(`purged ${purged} expired session(s)`)
  for (;;) {
    kicked = false
    const counts = await runPending()
    if (counts.processed) {
      console.log(
        `processed=${counts.processed} succeeded=${counts.succeeded}` +
          ` requeued=${counts.requeued} dead=${counts.dead}`,
      )
    }
    if (once) return
    const wait = await secondsUntilDue()
    // A kick that landed while that query was in flight means new work.
    if (kicked) continue
    if (wait === null) {
      onIdle?.()
      return
    }
    await new Promise<void>((done) => {
      const timer = setTimeout(finish, wait * 1000)
      function finish(): void {
        clearTimeout(timer)
        wake = null
        done()
      }
      wake = finish
    })
  }
}

/** Run jobs until none is due or will fall due, waiting out retry backoff. */
export function drain(once = false): Promise<void> {
  return loop(once)
}

/**
 * Make sure a drain is running. Cheap to call after every enqueue. Returns the
 * running drain so a test can await it, or null when draining in-process is off.
 */
export function kick(): Promise<void> | null {
  if (!settings.drainInProcess) return null
  kicked = true
  wake?.()
  running ??= loop(false, () => {
    running = null
  }).catch((err: unknown) => {
    // Jobs left queued here wait for the next kick: an upload or a restart.
    console.error('drain failed', err)
    running = null
  })
  return running
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await drain(process.argv.includes('--once'))
  } finally {
    await closePool()
  }
}
