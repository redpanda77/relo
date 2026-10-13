import type { Database } from "./db.js";

/** Deadline timer for maintenance, independent of delivery slots. A locked overdue
 * request retries at a bounded cadence rather than creating a zero-delay spin. */
export async function nextInteractionExpiryDelay(db: Pick<Database, "query">, fallbackMs: number): Promise<number> {
  if (!Number.isFinite(fallbackMs) || fallbackMs < 1) throw new Error("invalid_expiry_fallback");
  const result = await db.query<{ delay_ms: number | string | null }>(
    `SELECT EXTRACT(EPOCH FROM (MIN(expires_at)-clock_timestamp()))*1000 AS delay_ms
     FROM interaction_requests WHERE state='pending'`,
  );
  const delay = result.rows[0]?.delay_ms;
  return delay == null ? fallbackMs : Math.min(fallbackMs, Math.max(25, Math.ceil(Number(delay))));
}
