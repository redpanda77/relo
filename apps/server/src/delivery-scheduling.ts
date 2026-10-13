import type { Database } from "./db.js";

/** Scheduled backoff wakes at its actual boundary; poll remains recovery only.
 * Ignore already-ready jobs here: a saturated lane must wait for a slot, not spin. */
export async function nextDeliveryWakeDelay(db: Pick<Database, "query">, fallbackMs: number, cutoverAt: Date): Promise<number> {
  const result = await db.query<{ delay_ms: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (MIN(GREATEST(j.available_at,
       COALESCE(j.provider_next_attempt_not_before,j.available_at)))-clock_timestamp()))*1000 AS delay_ms
     FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
     WHERE j.state IN ('pending','retry') AND e.created_at >= $1 AND e.state='active'
       AND (e.expires_at IS NULL OR e.expires_at>now())
       AND GREATEST(j.available_at,COALESCE(j.provider_next_attempt_not_before,j.available_at))>clock_timestamp()`,
    [cutoverAt],
  );
  const delay = result.rows[0]?.delay_ms;
  return delay == null ? fallbackMs : Math.max(1,Math.min(fallbackMs,Math.ceil(Number(delay))));
}
