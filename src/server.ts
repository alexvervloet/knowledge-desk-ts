/**
 * Process entrypoint. Builds the app, applies pending migrations when asked, and
 * listens.
 *
 * Migrations run here rather than in a separate container command because the
 * app role and the RLS policies have to exist before the first request, and the
 * deploy has one process to hang that on.
 */

import { buildApp } from './app.ts'
import { closePool } from './db.ts'
import { applyPending } from './migrate.ts'
import { kick } from './worker.ts'

const PORT = Number(process.env.PORT ?? 8000)
const HOST = process.env.HOST ?? '0.0.0.0'

if (process.env.RUN_MIGRATIONS === '1') {
  console.log('migrating')
  await applyPending()
}

const app = await buildApp()

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      await app.close()
      await closePool()
      process.exit(0)
    })()
  })
}

await app.listen({ port: PORT, host: HOST })
console.log(`knowledge-desk listening on http://${HOST}:${PORT}`)

// Pick up whatever the last process left: jobs queued when the machine stopped,
// or one it died in the middle of. There is no worker that would.
void kick()
