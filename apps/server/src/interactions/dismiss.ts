import type { Database } from "../db.js";

export type DismissResult = { kind: "dismissed"; dismissedAt: Date } | { kind: "not_found" };

/**
 * The owner dismisses a missed question (STATE-SPEC 6.2: device dismissal never applies to Needs you,
 * so this is an owner decision that the question no longer needs them). Only a missed question of
 * the account: expired, never answered late. It leaves Needs you on every surface, stays in History
 * and refuses later late answers. Its copies on the same card or work that were missed with it (one
 * per phone) are dismissed too, so no surface keeps asking. Idempotent: a dismissed one is dismissed.
 */
export async function dismissMissedQuestion(db: Database,input: {
  principalId: string; interactionId: string; deviceId: string | null;
}): Promise<DismissResult> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const target = (await tx.query<{ id: string; state: string; late_responded_at: Date | null; owner_dismissed_at: Date | null;
      created_at: Date; work_id: string | null; activity_id: string | null }>(
      `SELECT r.id,r.state::text AS state,r.late_responded_at,r.owner_dismissed_at,r.created_at,r.work_id,
         e.payload#>>'{liveActivity,activityId}' AS activity_id
       FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id AND e.principal_id=r.principal_id
       WHERE r.id=$1 AND r.principal_id=$2 FOR UPDATE OF r`,[input.interactionId,input.principalId])).rows[0];
    if (!target) { await tx.query("ROLLBACK"); return { kind: "not_found" }; }
    if (target.owner_dismissed_at) { await tx.query("COMMIT"); return { kind: "dismissed",dismissedAt: target.owner_dismissed_at }; }
    if (target.state !== "expired" || target.late_responded_at) { await tx.query("ROLLBACK"); return { kind: "not_found" }; }
    const dismissed = (await tx.query<{ owner_dismissed_at: Date }>(
      `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
       UPDATE interaction_requests r SET owner_dismissed_at=clock.at,dismissed_by_device=$3
       FROM clock WHERE r.principal_id=$2 AND r.state='expired' AND r.late_responded_at IS NULL AND r.owner_dismissed_at IS NULL
         AND (r.id=$1 OR r.created_at<=$4 AND (
           ($5::uuid IS NOT NULL AND r.work_id=$5::uuid)
           OR ($6::text IS NOT NULL AND EXISTS (SELECT 1 FROM notification_events e WHERE e.id=r.notification_event_id
             AND e.principal_id=r.principal_id AND e.payload#>>'{liveActivity,activityId}'=$6))))
       RETURNING r.id,r.owner_dismissed_at`,
      [target.id,input.principalId,input.deviceId,target.created_at,target.work_id,target.activity_id])).rows;
    await tx.query("COMMIT");
    return { kind: "dismissed",dismissedAt: dismissed[0]!.owner_dismissed_at };
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}
