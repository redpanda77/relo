import { internalId } from "./ids.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };

/** Caller owns the transaction and has authorized access to the event.
 * Activity mutations acquire activity -> request -> event locks. Every decision
 * writer must use that same order, including read-triggered expiry.
 */
export async function lockDecisionActivity(
  query: Queryable, principalId: string, notificationEventId: string, skipLocked = false,
): Promise<boolean> {
  const event = await query.query(
    `SELECT e.payload#>>'{liveActivity,activityId}' AS activity_id
     FROM notification_events e WHERE e.id=$1 AND e.principal_id=$2`,
    [notificationEventId,principalId],
  );
  const activityId = internalId("act",event.rows[0]?.activity_id ?? "");
  if (!activityId) return true;
  // Missing historical activities have nothing to lock; their request can still expire.
  const exists = await query.query("SELECT id FROM live_activities WHERE id=$1 AND principal_id=$2",
    [activityId,principalId]);
  if (!exists.rowCount) return true;
  const locked = await query.query(
    `SELECT id FROM live_activities WHERE id=$1 AND principal_id=$2 FOR UPDATE${skipLocked ? " SKIP LOCKED" : ""}`,
    [activityId,principalId],
  );
  return Boolean(locked.rowCount);
}
