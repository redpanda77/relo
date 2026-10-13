import type { Database } from "./db.js";
import { pendingDecisionJoins,pendingDecisionPredicate,pendingDeviceVisibility,pendingRequestCandidates } from "./pending-inventory.js";

export async function pendingInteractionBadgeCount(db: Database, deviceId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `WITH requests AS MATERIALIZED (${pendingRequestCandidates("(SELECT principal_id FROM devices WHERE id=$1 AND revoked_at IS NULL)","clock_timestamp()")})
     SELECT count(*)::int AS count
     FROM requests r ${pendingDecisionJoins}
     JOIN devices d ON d.id=$1 AND d.principal_id=e.principal_id AND d.revoked_at IS NULL
     WHERE ${pendingDecisionPredicate("clock_timestamp()",pendingDeviceVisibility)}`,
    [deviceId],
  );
  return result.rows[0]?.count ?? 0;
}
