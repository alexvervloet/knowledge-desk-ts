/**
 * The job queue's two newer promises: a job whose claimer died is handed out
 * again, and `secondsUntilDue` says when anything will next be due, which is
 * what lets a drain stop.
 */

import { describe, expect, it } from 'vitest'
import * as accounts from '../src/accounts.ts'
import { settings } from '../src/config.ts'
import { connect } from '../src/db.ts'
import * as jobs from '../src/jobs.ts'
import { useCleanDb } from './helpers.ts'

useCleanDb()

async function org(): Promise<string> {
  return (await accounts.createOrgWithOwner('acme', 'Acme', 'o@acme.test', 'pw-supersecret')).orgId
}

async function claim(): Promise<jobs.Job> {
  const job = await jobs.claimOne()
  expect(job, 'expected a claimable job').not.toBeNull()
  return job as jobs.Job
}

/** Pretend every running job was claimed `seconds` ago. */
async function ageClaim(seconds: number): Promise<void> {
  await connect(null, (conn) =>
    conn.exec(
      "update jobs set updated_at = now() - make_interval(secs => $1) where status = 'running'",
      [seconds],
    ),
  )
}

describe('stale claims', () => {
  it('hands out a running job again once its claim is stale', async () => {
    // The claiming process died before marking it: the machine stopped mid-job.
    await jobs.enqueue(await org(), 'noop', {}, 'k')
    await claim()
    await ageClaim(settings.jobStaleAfterSeconds + 1)
    expect((await claim()).attempts).toBe(2) // the lost run still counts
  })

  it('leaves a running job alone before then', async () => {
    await jobs.enqueue(await org(), 'noop', {}, 'k')
    await claim()
    await ageClaim(settings.jobStaleAfterSeconds - 60)
    expect(await jobs.claimOne()).toBeNull()
  })
})

describe('secondsUntilDue', () => {
  it('tracks queued work, retries, and finished work', async () => {
    expect(await jobs.secondsUntilDue()).toBeNull() // nothing will ever be due

    await jobs.enqueue(await org(), 'noop', {}, 'k')
    expect(await jobs.secondsUntilDue()).toBe(0) // due now

    await jobs.markFailed((await claim()).id, 'boom', 30)
    const wait = await jobs.secondsUntilDue()
    expect(wait).toBeGreaterThan(25)
    expect(wait).toBeLessThanOrEqual(30) // waiting on the retry

    await connect(null, (conn) => conn.exec("update jobs set status = 'succeeded'"))
    expect(await jobs.secondsUntilDue()).toBeNull() // finished work is never due
  })

  it('counts a running job as due when it would go stale', async () => {
    await jobs.enqueue(await org(), 'noop', {}, 'k')
    await claim()
    const wait = await jobs.secondsUntilDue()
    expect(wait).toBeGreaterThan(settings.jobStaleAfterSeconds - 5)
    expect(wait).toBeLessThanOrEqual(settings.jobStaleAfterSeconds)
  })
})
