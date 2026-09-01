import type { Database } from "./db.js";

export const DELIVERY_JOB_TTL_SECONDS = 5 * 60;
export const TERMINAL_DELIVERY_JOB_TTL_SECONDS = 60 * 60;

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
         WHEN e.expires_at IS NOT NULL AND e.expires_at<=now() THEN 'event_expired'
         ELSE 'delivery_deadline_exceeded' END,
       last_error_message=CASE WHEN e.state<>'active' THEN 'Notification event is terminal'
         WHEN e.expires_at IS NOT NULL AND e.expires_at<=now()
           THEN 'Notification event expired before delivery'
         ELSE CASE WHEN e.payload#>>'{liveActivity,operation}'='end'
           THEN 'Terminal Live Activity delivery exceeded its one-hour reconciliation window'
           ELSE 'Delivery job exceeded its five-minute delivery window' END END,updated_at=now()
     FROM notification_events e WHERE e.id=j.notification_event_id
       AND j.state IN ('pending','retry')
       AND (e.state<>'active' OR (e.expires_at IS NOT NULL AND e.expires_at<=now())
         OR j.created_at<=now()-(CASE WHEN e.payload#>>'{liveActivity,operation}'='end'
           THEN ($2*interval '1 second') ELSE ($1*interval '1 second') END))`,
    [DELIVERY_JOB_TTL_SECONDS,TERMINAL_DELIVERY_JOB_TTL_SECONDS],
  );
  return result.rowCount ?? 0;
}
