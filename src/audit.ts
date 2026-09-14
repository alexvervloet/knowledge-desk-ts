/**
 * Append-only audit log. Records who did what, in which org, and when, so an
 * org admin can review activity.
 *
 * Writes are best-effort: an audit failure logs a warning but never propagates,
 * because losing the ability to record an event must not take down the action the
 * user was performing. The trade-off is that a dropped write is a gap in the log,
 * not a failed request.
 */

import { connect } from './db.ts'
import * as pii from './pii.ts'

export async function log(
  orgId: string,
  actorUserId: string | null,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    const safeDetail = pii.redactDetail(detail)
    await connect(orgId, (conn) =>
      conn.exec(
        'insert into audit_log(org_id, actor_user_id, action, detail) values ($1, $2, $3, $4)',
        [orgId, actorUserId, action, JSON.stringify(safeDetail)],
      ),
    )
  } catch (err) {
    // Audit must never break the request.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[audit] failed to record ${action}: ${message}`)
  }
}
