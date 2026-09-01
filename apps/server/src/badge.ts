import type { Database } from "./db.js";

export async function pendingInteractionBadgeCount(db: Database, deviceId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM interaction_requests r
     JOIN notification_events e ON e.id=r.notification_event_id AND e.principal_id=r.principal_id
     JOIN devices d ON d.id=$1 AND d.principal_id=e.principal_id AND d.revoked_at IS NULL
     WHERE r.state='pending' AND r.expires_at>now()
       AND (e.target_mode='broadcast' OR EXISTS (
         SELECT 1 FROM notification_event_targets t
         WHERE t.notification_event_id=e.id AND t.device_id=d.id
       ))`,
    [deviceId],
  );
  return result.rows[0]?.count ?? 0;
}
