import { createHash } from "node:crypto";
import type {
  ApnsEnvironment,
  ApnsOutcome,
  BackgroundSend,
  OutcomeCategory,
  RecipientResolver,
  ResolvedRecipient,
} from "../apns-provider-cleanroom.js";
import type { Database } from "../db.js";
import { publicId } from "../ids.js";
import { PostgresListener } from "../postgres-listener.js";
import { clearTransportTokenIfUnchanged, type TransportTokenEncryption } from "../token-encryption.js";

/**
 * Settle pushes: when a notification stops being active (a question answered on any surface, settled as
 * another copy of its decision, expired, canceled or superseded; a notice withdrawn, such as a retired
 * question fallback), every phone that was sent its alert gets one silent background push naming it, so
 * the phone removes the stale notification.
 *
 * Queueing has one choke point in the database: the trigger of migration 0117 fires whenever
 * notification_events.state leaves 'active', whichever module wrote it, and queues one row per
 * (notification, device) whose ordinary alert job reached APNs. This module sends them.
 *
 * Wire contract (the iOS app removes delivered notifications whose relo.notificationId is listed):
 * apns-push-type background, apns-priority 5, the ordinary topic, and only
 * {"aps":{"content-available":1},"relo":{"settled":["ntf_..."]}}. Ids only: no title, body or context.
 */

export const SETTLE_PUSH_CHANNEL = "relo_settle_pushes";
/** Ids per push: about 43 bytes each, so a full push stays near half of APNs' 4 KB. */
export const SETTLE_IDS_PER_PUSH = 50;
export const SETTLE_PUSH_MAX_ATTEMPTS = 5;
/** A settle push older than this is dropped: a phone away that long reconciles when Relo opens. */
export const SETTLE_PUSH_LIFETIME_MS = 24 * 60 * 60_000;
const CLAIM_LIMIT = 100;
const LEASE_SECONDS = 300;

export type SettlePushSender = { sendBackground(input: BackgroundSend): Promise<ApnsOutcome> };

export type SettlePushCycle = {
  claimed: number; sent: number; skipped: number; retried: number; failed: number; requeued: number;
};

/** The custom data of one settle push (the provider adds aps.content-available). */
export function settlePayload(notificationEventIds: readonly string[]): { relo: { settled: string[] } } {
  if (notificationEventIds.length === 0 || notificationEventIds.length > SETTLE_IDS_PER_PUSH) {
    throw new Error("A settle push names 1 to 50 notifications");
  }
  return { relo: { settled: notificationEventIds.map((id) => publicId("ntf",id)) } };
}

/** Outcomes worth another attempt later; every other failure is final. */
const RETRYABLE = new Set<OutcomeCategory>([
  "indeterminate-transport","retry-exhausted","retryable-not-scheduled","retry-scheduled","pool-quarantined",
  "expired-provider-token","bounded-protocol-failure","ambiguous-rate-limit","recipient-throttled",
  "provider-token-cadence",
]);

type ClaimedRow = { id: string; notification_event_id: string; device_id: string; attempt_count: number; created_at: Date };

/** One pass: recover lost leases, drop what can no longer matter, then send what is due. */
export async function dispatchDueSettlePushes(db: Database,input: {
  sender: SettlePushSender; encryption: TransportTokenEncryption; environment: ApnsEnvironment;
  limit?: number; signal?: AbortSignal;
}): Promise<SettlePushCycle> {
  const cycle: SettlePushCycle = { claimed: 0,sent: 0,skipped: 0,retried: 0,failed: 0,requeued: 0 };
  // A worker that stopped mid-send left its claim; a repeated settle push is harmless to the phone.
  cycle.requeued = (await db.query(
    `UPDATE notification_settle_pushes SET state='pending',claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
     WHERE state='processing' AND lease_expires_at<clock_timestamp()`)).rowCount ?? 0;
  cycle.failed += (await db.query(
    `UPDATE notification_settle_pushes SET state='failed',outcome_category='expired',updated_at=clock_timestamp()
     WHERE state='pending' AND created_at<clock_timestamp()-($1::bigint*interval '1 millisecond')`,
    [SETTLE_PUSH_LIFETIME_MS])).rowCount ?? 0;
  // Queued while its alert was in flight, and the alert never reached APNs: the phone has nothing to remove.
  cycle.skipped += (await db.query(
    `UPDATE notification_settle_pushes s SET state='skipped',outcome_category='alert_not_delivered',updated_at=clock_timestamp()
     WHERE s.state='pending' AND NOT EXISTS (SELECT 1 FROM delivery_jobs j
       WHERE j.notification_event_id=s.notification_event_id AND j.device_id=s.device_id AND j.transport='notification'
         AND j.state IN ('accepted','reconciliation_required','processing'))`)).rowCount ?? 0;
  const claimToken = (await db.query<{ token: string }>("SELECT gen_random_uuid() AS token")).rows[0]!.token;
  // An alert still in flight is waited for, so the settle push never overtakes the alert it removes.
  const claimed = (await db.query<ClaimedRow>(
    `WITH due AS (
       SELECT s.id FROM notification_settle_pushes s
       WHERE s.state='pending' AND s.available_at<=clock_timestamp()
         AND NOT EXISTS (SELECT 1 FROM delivery_jobs j WHERE j.notification_event_id=s.notification_event_id
           AND j.device_id=s.device_id AND j.transport='notification' AND j.state='processing')
       ORDER BY s.available_at,s.id LIMIT $1 FOR UPDATE OF s SKIP LOCKED)
     UPDATE notification_settle_pushes s SET state='processing',claim_token=$2,
       lease_expires_at=clock_timestamp()+($3::integer*interval '1 second'),attempt_count=s.attempt_count+1,
       updated_at=clock_timestamp()
     FROM due WHERE s.id=due.id
     RETURNING s.id,s.notification_event_id,s.device_id,s.attempt_count,s.created_at`,
    [input.limit ?? CLAIM_LIMIT,claimToken,LEASE_SECONDS])).rows;
  cycle.claimed = claimed.length;
  const byDevice = new Map<string,ClaimedRow[]>();
  for (const row of claimed) byDevice.set(row.device_id,[...byDevice.get(row.device_id) ?? [],row]);
  for (const [deviceId,rows] of byDevice) {
    for (let start = 0; start < rows.length; start += SETTLE_IDS_PER_PUSH) {
      const batch = rows.slice(start,start+SETTLE_IDS_PER_PUSH);
      const validUntilMs = Math.min(...batch.map((row) => row.created_at.getTime()))+SETTLE_PUSH_LIFETIME_MS;
      let outcome: ApnsOutcome | undefined;
      try {
        outcome = await input.sender.sendBackground({
          recipient: new DeviceApnsRecipient(db,input.encryption,deviceId,input.environment),
          customData: settlePayload(batch.map((row) => row.notification_event_id)),
          priority: 5,
          expiration: Math.floor(validUntilMs/1_000),
          validUntilMs,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch {
        outcome = undefined;
      }
      const result = await finalize(db,claimToken,batch,outcome);
      cycle[result] += batch.length;
    }
  }
  return cycle;
}

async function finalize(db: Database,claimToken: string,batch: ClaimedRow[],
  outcome: ApnsOutcome | undefined): Promise<"sent" | "skipped" | "retried" | "failed"> {
  const ids = batch.map((row) => row.id);
  const category = outcome?.category ?? "indeterminate-transport";
  const status = outcome?.status ?? null;
  const result = category === "accepted" ? "sent"
    : category === "stale-recipient" ? "skipped"
      : RETRYABLE.has(category) && Math.max(...batch.map((row) => row.attempt_count)) < SETTLE_PUSH_MAX_ATTEMPTS ? "retried"
        : "failed";
  const state = result === "sent" ? "sent" : result === "skipped" ? "skipped" : result === "retried" ? "pending" : "failed";
  await db.query(
    `UPDATE notification_settle_pushes SET state=$3,claim_token=NULL,lease_expires_at=NULL,outcome_category=$4,
       provider_status=$5,sent_at=CASE WHEN $3='sent' THEN clock_timestamp() ELSE sent_at END,
       available_at=CASE WHEN $3='pending' THEN clock_timestamp()+(LEAST(300,5*power(2,attempt_count-1))*interval '1 second')
         ELSE available_at END,
       updated_at=clock_timestamp()
     WHERE id=ANY($1::uuid[]) AND claim_token=$2 AND state='processing'`,
    [ids,claimToken,state,category,status]);
  return result;
}

/** The device's ordinary APNs token, if it still has one; a token APNs reports unregistered is cleared. */
class DeviceApnsRecipient implements RecipientResolver {
  constructor(private readonly db: Database,private readonly encryption: TransportTokenEncryption,
    private readonly deviceId: string,private readonly environment: ApnsEnvironment) {}

  private async ciphertext(): Promise<string | null> {
    return (await this.db.query<{ apns_token: string }>(
      `SELECT apns_token FROM devices WHERE id=$1 AND revoked_at IS NULL AND apns_token IS NOT NULL AND apns_environment=$2`,
      [this.deviceId,this.environment])).rows[0]?.apns_token ?? null;
  }

  async resolve(): Promise<ResolvedRecipient | null> {
    const ciphertext = await this.ciphertext();
    if (!ciphertext) return null;
    const token = this.encryption.decrypt(ciphertext,"device.apns_token");
    return token ? { token,generation: generation(ciphertext) } : null;
  }

  async invalidate(expectedGeneration: string,details: { environment: ApnsEnvironment }): Promise<void> {
    if (details.environment !== this.environment) throw new Error("APNs invalidation environment does not match the recipient");
    const ciphertext = await this.ciphertext();
    if (ciphertext && generation(ciphertext) === expectedGeneration) {
      await clearTransportTokenIfUnchanged(this.db,{ purpose: "device.apns_token",deviceId: this.deviceId,ciphertext });
    }
  }
}

function generation(ciphertext: string): string {
  return createHash("sha256").update(ciphertext,"utf8").digest("hex");
}

/** The worker's settle loop: woken by the trigger's notification, with a poll as the fallback. */
export async function runSettlePushLoop(db: Database,input: {
  sender: SettlePushSender; encryption: TransportTokenEncryption; environment: ApnsEnvironment;
  pollMs: number; signal: AbortSignal; log: (cycle: SettlePushCycle) => void;
}): Promise<void> {
  let wake: (() => void) | undefined;
  let pending = false;
  const listener = await PostgresListener.listen(db,SETTLE_PUSH_CHANNEL,() => { pending = true;wake?.(); });
  try {
    while (!input.signal.aborted) {
      pending = false;
      let cycle: SettlePushCycle | undefined;
      try {
        cycle = await dispatchDueSettlePushes(db,input);
        if (Object.values(cycle).some((value) => value > 0)) input.log(cycle);
      } catch (error) {
        console.warn(JSON.stringify({ event: "settle_push_cycle_failed",
          message: error instanceof Error ? error.message : String(error) }));
      }
      if (cycle && cycle.claimed >= CLAIM_LIMIT) continue;
      if (pending) continue;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer);input.signal.removeEventListener("abort",done);wake = undefined;resolve(); };
        const timer = setTimeout(done,input.pollMs);
        input.signal.addEventListener("abort",done,{ once: true });
        wake = done;
      });
    }
  } finally {
    await listener.close();
  }
}
