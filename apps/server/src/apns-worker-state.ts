import type { Database } from "./db.js";
import { relevanceDeliveryDeadline,relevanceDeliveryGuard } from "./relevance/delivery.js";
import type { DeliveryLane } from "./delivery-dispatcher.js";
import type { ApnsRuntimeResult } from "./apns-runtime.js";
import type {
  DeliverySerializationEvidence,
} from "./delivery-serialization.js";

export type ClaimedDeliveryJob = {
  id: string;
  claim_token: string;
  canonical_intent_sha256: string | null;
  device_projection_sha256: string | null;
  ordinary_delivery_inputs: unknown;
  principal_id: string;
  device_id: string;
  transport: "notification" | "live_activity_start" | "live_activity_update";
  live_activity_id: string | null;
  event_id: string;
  title: string;
  body: string;
  source: string;
  service_id: string | null;
  requester_credential_id: string | null;
  origin_hash: string | null;
  service_image_url: string | null;
  image_url: string | null;
  deep_link: string | null;
  expires_at: Date | null;
  payload: Record<string, unknown>;
  interaction_kind: "approval" | "yes_no" | "text" | null;
  interaction_id: string | null;
  interaction_state: "pending" | "approved" | "denied" | "yes" | "no" | "expired" | "canceled" | null;
  interaction_expires_at: Date | null;
  credential_version: number;
  attempt_count: number;
  provider_attempts_used: number;
  provider_retry_started_at: Date | null;
  provider_retry_attempt_cap: number | null;
  provider_retry_horizon_at: Date | null;
  provider_next_attempt_not_before: Date | null;
  provider_status: number | null;
  apns_priority: 5 | 10 | null;
  first_claimed_at: Date | null;
  last_claimed_at: Date | null;
  last_dispatch_started_at: Date | null;
  created_at: Date;
};

export class DeliveryClaimOwnershipLostError extends Error {
  constructor() {
    super("Delivery job claim ownership was lost");
    this.name = "DeliveryClaimOwnershipLostError";
  }
}

export class DeliverySerializationMismatchError extends Error {
  constructor() {
    super("Delivery serialization evidence changed across claims");
    this.name = "DeliverySerializationMismatchError";
  }
}

export async function claimDeliveryJobs(
  db: Database,
  limit: number,
  cutoverAt: Date,
  lane?: DeliveryLane,
): Promise<ClaimedDeliveryJob[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("claim limit must be between 1 and 100");
  const result = await db.query<ClaimedDeliveryJob & { available_at: Date }>(
    `WITH candidates AS (
       SELECT j.id FROM delivery_jobs j JOIN notification_events candidate_event
         ON candidate_event.id=j.notification_event_id
       JOIN devices candidate_device ON candidate_device.id=j.device_id
         AND candidate_device.principal_id=candidate_event.principal_id
       CROSS JOIN LATERAL (SELECT (
         candidate_event.payload#>>'{liveActivity,operation}'='end'
         OR EXISTS (SELECT 1 FROM interaction_requests request
           WHERE request.notification_event_id=candidate_event.id
             AND request.state='pending' AND request.expires_at>now())
       ) IS TRUE AS urgent) priority
       WHERE j.state IN ('pending','retry') AND j.available_at<=now()
         AND candidate_event.created_at >= $2
         AND candidate_event.state='active'
         AND (candidate_event.expires_at IS NULL OR candidate_event.expires_at>now())
         AND ${relevanceDeliveryGuard("candidate_event")}
         AND ($3::text IS NULL OR priority.urgent=($3='urgent'))
         AND (j.provider_next_attempt_not_before IS NULL OR j.provider_next_attempt_not_before<=now())
       ORDER BY j.available_at,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT $1
     )
     UPDATE delivery_jobs j SET state='processing',attempt_count=j.attempt_count+1,
       claim_token=gen_random_uuid(),claim_started_at=now(),claim_phase='preparing',
       first_claimed_at=COALESCE(j.first_claimed_at,clock_timestamp()),last_claimed_at=clock_timestamp(),
       lease_expires_at=now()+interval '2 minutes',updated_at=now()
     FROM candidates c,notification_events e,devices d
     WHERE j.id=c.id AND e.id=j.notification_event_id AND d.id=j.device_id
       AND d.principal_id=e.principal_id
     RETURNING j.id,j.claim_token,j.available_at,j.canonical_intent_sha256,
       j.device_projection_sha256,j.ordinary_delivery_inputs,e.principal_id,j.device_id,j.transport,j.live_activity_id,
       e.id AS event_id,e.title,e.body,e.source,e.service_id,e.requester_credential_id,e.origin_hash,
       (SELECT s.image_url FROM webhook_services s WHERE s.id=e.service_id) AS service_image_url,
       e.image_url,e.deep_link,
       ${relevanceDeliveryDeadline("e")} AS expires_at,e.payload,j.attempt_count,
       j.provider_attempts_used,j.provider_retry_started_at,j.provider_retry_attempt_cap,
       j.provider_retry_horizon_at,j.provider_next_attempt_not_before,j.provider_status,j.created_at,
       j.apns_priority,j.first_claimed_at,j.last_claimed_at,j.last_dispatch_started_at,
       d.credential_version,
       (SELECT r.id FROM interaction_requests r WHERE r.notification_event_id=e.id) AS interaction_id,
       (SELECT r.kind FROM interaction_requests r WHERE r.notification_event_id=e.id) AS interaction_kind,
       (SELECT r.state FROM interaction_requests r WHERE r.notification_event_id=e.id) AS interaction_state,
       (SELECT r.expires_at FROM interaction_requests r WHERE r.notification_event_id=e.id) AS interaction_expires_at`,
    [limit,cutoverAt,lane ?? null],
  );
  return result.rows.sort((a,b) => a.available_at.getTime()-b.available_at.getTime()
    || a.created_at.getTime()-b.created_at.getTime() || a.id.localeCompare(b.id));
}

export async function pinDeliverySerializationEvidence(
  db: Pick<Database, "query">,
  job: Pick<ClaimedDeliveryJob, "id" | "claim_token">,
  evidence: DeliverySerializationEvidence,
): Promise<void> {
  const updated = await db.query(
    `UPDATE delivery_jobs SET canonical_intent_sha256=COALESCE(canonical_intent_sha256,$3),
       device_projection_sha256=COALESCE(device_projection_sha256,$4),updated_at=now()
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='preparing'
       AND (canonical_intent_sha256 IS NULL OR canonical_intent_sha256=$3)
       AND (device_projection_sha256 IS NULL OR device_projection_sha256=$4)`,
    [job.id,job.claim_token,evidence.canonicalIntentSha256,evidence.deviceProjectionSha256],
  );
  if (updated.rowCount === 1) return;
  const current = await db.query<{
    canonical_intent_sha256: string | null;
    device_projection_sha256: string | null;
  }>(
    `SELECT canonical_intent_sha256,device_projection_sha256
     FROM delivery_jobs
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='preparing'`,
    [job.id,job.claim_token],
  );
  if (current.rowCount !== 1) throw new DeliveryClaimOwnershipLostError();
  throw new DeliverySerializationMismatchError();
}

export async function quarantineDeliverySerializationMismatch(
  db: Pick<Database, "query">,
  job: Pick<ClaimedDeliveryJob, "id" | "claim_token">,
): Promise<void> {
  const updated = await db.query(
    `UPDATE delivery_jobs SET state='permanently_failed',
       last_error_code='delivery_serialization_mismatch',
       last_error_message='Pinned delivery serialization evidence changed before dispatch',
       claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='preparing'`,
    [job.id,job.claim_token],
  );
  requireOwned(updated.rowCount);
}

export async function quarantineInvalidDeliverySerialization(
  db: Pick<Database, "query">,
  job: Pick<ClaimedDeliveryJob, "id" | "claim_token">,
): Promise<void> {
  const updated = await db.query(
    `UPDATE delivery_jobs SET state='permanently_failed',
       last_error_code='delivery_serialization_invalid',
       last_error_message='Delivery intent is invalid for the current serializer',
       claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='preparing'`,
    [job.id,job.claim_token],
  );
  requireOwned(updated.rowCount);
}

export async function quarantineAbandonedProcessingClaims(
  db: Pick<Database,"query">,
): Promise<{ safelyRequeued: number; reconciliationRequired: number }> {
  const safe = await db.query(
    `UPDATE delivery_jobs SET state='retry',claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,
       lease_expires_at=NULL,last_error_code='pre_dispatch_claim_expired',
       last_error_message='Provider claim expired before the durable dispatch fence',updated_at=now()
     WHERE state='processing' AND claim_phase='preparing'
       AND (lease_expires_at IS NULL OR lease_expires_at<now())`,
  );
  const uncertain = await db.query(
    `UPDATE delivery_jobs SET state='reconciliation_required',claim_token=NULL,claim_started_at=NULL,
       claim_phase=NULL,lease_expires_at=NULL,last_error_code='abandoned_provider_claim',
       last_error_message='Provider claim ended at or after the durable dispatch fence',updated_at=now()
     WHERE state='processing' AND claim_phase IS DISTINCT FROM 'preparing'
       AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at<now())`,
  );
  return {
    safelyRequeued: safe.rowCount ?? 0,
    reconciliationRequired: uncertain.rowCount ?? 0,
  };
}

export async function markDeliveryDispatchStarted(
  db: Pick<Database, "query">,
  jobId: string,
  claimToken: string,
  priority: 5 | 10,
): Promise<void> {
  const result = await db.query(
    `UPDATE delivery_jobs SET claim_phase='dispatch_started',apns_priority=$3,
       last_dispatch_started_at=clock_timestamp(),updated_at=now()
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='preparing'`,
    [jobId,claimToken,priority],
  );
  requireOwned(result.rowCount);
}

export async function heartbeatDeliveryClaim(
  db: Pick<Database, "query">,
  jobId: string,
  claimToken: string,
): Promise<void> {
  const result = await db.query(
    `UPDATE delivery_jobs SET lease_expires_at=now()+interval '2 minutes',updated_at=now()
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='dispatch_started'`,
    [jobId,claimToken],
  );
  requireOwned(result.rowCount);
}

export async function retryPreparingDeliveryClaim(
  db: Pick<Database, "query">,
  job: Pick<ClaimedDeliveryJob, "id" | "claim_token">,
): Promise<void> {
  const updated = await db.query(
    `UPDATE delivery_jobs SET state='retry',available_at=now()+interval '5 seconds',
       last_error_code='pre_dispatch_runtime_error',
       last_error_message='Worker preparation failed before the durable APNs dispatch fence',
       claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='preparing'`,
    [job.id,job.claim_token],
  );
  requireOwned(updated.rowCount);
}

export async function deferFutureActivityTimestamp(
  db: Pick<Database, "query">,
  job: Pick<ClaimedDeliveryJob, "id" | "claim_token">,
  providerTimestamp: number,
): Promise<void> {
  if (!Number.isSafeInteger(providerTimestamp) || providerTimestamp < 0) {
    throw new Error("invalid future Live Activity provider timestamp");
  }
  const updated = await db.query(
    `UPDATE delivery_jobs SET state='retry',available_at=GREATEST(now(),to_timestamp($3)),
       last_error_code='activity_timestamp_pending',
       last_error_message='Live Activity command is waiting for its monotonic provider timestamp',
       claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='preparing'`,
    [job.id,job.claim_token,providerTimestamp],
  );
  requireOwned(updated.rowCount);
}

export async function withJobLeaseHeartbeat<T>(
  db: Pick<Database, "query">,
  jobId: string,
  claimToken: string,
  outerSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let heartbeat: Promise<void> | undefined;
  let heartbeatFailure: unknown;
  if (outerSignal.aborted) controller.abort();
  else outerSignal.addEventListener("abort",abort,{ once: true });
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = heartbeatDeliveryClaim(db,jobId,claimToken)
      .then(async () => { await quarantineAbandonedProcessingClaims(db); })
      .catch((error) => {
        heartbeatFailure = error;
        controller.abort();
      })
      .finally(() => { heartbeat = undefined; });
  },30_000);
  timer.unref();
  try {
    let result: T;
    try {
      result = await operation(controller.signal);
    } catch (error) {
      if (heartbeat) await heartbeat;
      if (heartbeatFailure) throw heartbeatFailure;
      throw error;
    }
    if (heartbeat) await heartbeat;
    if (heartbeatFailure) throw heartbeatFailure;
    return result;
  } finally {
    clearInterval(timer);
    outerSignal.removeEventListener("abort",abort);
  }
}

export async function finalizeDeliveryClaim(
  db: Database,
  job: ClaimedDeliveryJob,
  result: Exclude<ApnsRuntimeResult, { kind: "unavailable" } | { kind: "reconcile" }>,
): Promise<void> {
  const terminalActivityJob = isTerminalActivityJob(job);
  let rescheduled = false;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (result.kind === "accepted") {
      const updated = await client.query(
        `UPDATE delivery_jobs SET state='accepted',provider_message_id=$3,accepted_at=now(),
           claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='dispatch_started'`,
        [job.id,job.claim_token,result.providerMessageId ?? null],
      );
      requireOwned(updated.rowCount);
    } else if (result.kind === "retry_scheduled") {
      const updated = await client.query(
        `UPDATE delivery_jobs SET state='retry',available_at=GREATEST(clock_timestamp(),provider_next_attempt_not_before),
           last_error_code=$4,last_error_message=$5,
           claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='dispatch_started'
           AND provider_next_attempt_not_before=$3
           AND provider_next_attempt_not_before<provider_retry_horizon_at
           AND provider_attempts_used<provider_retry_attempt_cap`,
        [job.id,job.claim_token,result.notBefore,result.code,result.message],
      );
      requireOwned(updated.rowCount);
      rescheduled = true;
    } else if (result.kind === "invalid_token") {
      const updated = await client.query(
        `UPDATE delivery_jobs SET state='token_invalid',last_error_code=$3,last_error_message=$4,
           claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='dispatch_started'`,
        [job.id,job.claim_token,result.code,result.message],
      );
      requireOwned(updated.rowCount);
    } else {
      const retry = result.kind === "retry" && job.attempt_count < 10;
      rescheduled = retry;
      const delaySeconds = Math.min(3_600,2 ** Math.min(job.attempt_count,10) * 5);
      const updated = await client.query(
        `UPDATE delivery_jobs SET state=$3::delivery_state,last_error_code=$4,last_error_message=$5,
           available_at=CASE WHEN $3::delivery_state='retry'
             THEN now()+($6*interval '1 second') ELSE available_at END,
           claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='dispatch_started'`,
        [job.id,job.claim_token,retry ? "retry" : "permanently_failed",result.code,result.message,delaySeconds],
      );
      requireOwned(updated.rowCount);
    }
    if (terminalActivityJob && result.kind === "accepted" && !rescheduled && job.live_activity_id) {
      await client.query(
        `DELETE FROM live_activity_update_tokens token USING delivery_jobs job
         WHERE token.live_activity_id=$1 AND token.device_id=$2 AND job.id=$3
           AND encode(sha256(convert_to(token.token,'UTF8')),'hex')=job.recipient_generation`,
        [job.live_activity_id,job.device_id,job.id],
      );
    }
    await client.query("UPDATE notification_events SET updated_at=now() WHERE id=$1",[job.event_id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markDeliveryClaimForReconciliation(
  db: Pick<Database, "query">,
  job: Pick<ClaimedDeliveryJob, "id" | "claim_token">,
  code: string,
  message: string,
  providerMessageId?: string,
): Promise<void> {
  const updated = await db.query(
    `UPDATE delivery_jobs SET state='reconciliation_required',provider_message_id=COALESCE($5,provider_message_id),
       last_error_code=$3,last_error_message=$4,claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,
       lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='dispatch_started'`,
    [job.id,job.claim_token,code,message,providerMessageId ?? null],
  );
  requireOwned(updated.rowCount);
}

export async function cancelUnavailableDeliveryClaim(
  db: Pick<Database, "query">,
  job: Pick<ClaimedDeliveryJob, "id" | "claim_token" | "event_id">,
  result: Extract<ApnsRuntimeResult, { kind: "unavailable" }>,
): Promise<void> {
  const updated = await db.query(
    `UPDATE delivery_jobs SET state='canceled',last_error_code=$3,last_error_message=$4,
       claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='dispatch_started'`,
    [job.id,job.claim_token,result.code,result.message],
  );
  requireOwned(updated.rowCount);
  await db.query("UPDATE notification_events SET updated_at=now() WHERE id=$1",[job.event_id]);
}

export async function deferMissingActivityToken(
  db: Pick<Database, "query">,
  job: ClaimedDeliveryJob,
  retry: boolean,
): Promise<void> {
  const delaySeconds = Math.min(60,5 * 2 ** Math.min(job.attempt_count-1,4));
  const updated = await db.query(
    `UPDATE delivery_jobs SET state=$3::delivery_state,
       last_error_code=CASE WHEN $3::delivery_state='retry'
         THEN 'activity_token_pending' ELSE 'event_expired' END,
       last_error_message=CASE WHEN $3::delivery_state='retry'
         THEN 'Live Activity update token is not registered'
         ELSE 'Live Activity expired before its update token was registered' END,
       available_at=CASE WHEN $3::delivery_state='retry'
         THEN now()+($4*interval '1 second') ELSE available_at END,
       claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='dispatch_started'`,
    [job.id,job.claim_token,retry ? "retry" : "permanently_failed",delaySeconds],
  );
  requireOwned(updated.rowCount);
  await db.query("UPDATE notification_events SET updated_at=now() WHERE id=$1",[job.event_id]);
}

function requireOwned(rowCount: number | null): void {
  if (rowCount !== 1) throw new DeliveryClaimOwnershipLostError();
}

function isTerminalActivityJob(job: ClaimedDeliveryJob): boolean {
  return job.transport === "live_activity_update"
    && job.payload?.liveActivity !== null
    && typeof job.payload?.liveActivity === "object"
    && !Array.isArray(job.payload.liveActivity)
    && (job.payload.liveActivity as Record<string,unknown>).operation === "end";
}
