import type { Database } from "./db.js";
import { relevanceDeliveryGuard } from "./relevance/delivery.js";

export function shouldRetryMissingActivityToken(
  job: { attempt_count: number; expires_at: Date | null },
  now = Date.now(),
): boolean {
  return job.attempt_count < 120 && (!job.expires_at || job.expires_at.getTime() > now);
}

export function futureActivityProviderTimestamp(
  command: unknown,
  now = Date.now(),
): number | null {
  if (!command || typeof command !== "object" || Array.isArray(command)) return null;
  const timestamp = (command as Record<string,unknown>).providerTimestamp;
  return Number.isSafeInteger(timestamp) && Number(timestamp) >= 0
    && Number(timestamp) > Math.floor(now/1_000)
    ? Number(timestamp)
    : null;
}

export async function cancelUndeliverableDeliveryJobs(db: Database): Promise<number> {
  const result = await db.query(
    `UPDATE delivery_jobs j SET state='canceled',lease_expires_at=NULL,
       last_error_code=CASE WHEN e.state<>'active' THEN 'event_terminal'
         WHEN e.expires_at IS NOT NULL AND e.expires_at<=clock_timestamp() THEN 'event_expired'
         ELSE 'relevance_delivery_closed' END,
       last_error_message=CASE WHEN e.state<>'active' THEN 'Notification event is terminal'
         WHEN e.expires_at IS NOT NULL AND e.expires_at<=clock_timestamp()
           THEN 'Notification event expired before delivery'
         ELSE 'The relevance delivery window is closed' END,updated_at=clock_timestamp()
     FROM notification_events e WHERE e.id=j.notification_event_id
       AND j.state IN ('pending','retry')
       AND (e.state<>'active' OR (e.expires_at IS NOT NULL AND e.expires_at<=clock_timestamp())
         OR NOT ${relevanceDeliveryGuard("e")})`,
  );
  return result.rowCount ?? 0;
}
