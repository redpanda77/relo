import type { Database } from "./db.js";
import {
  DeliveryClaimOwnershipLostError,DeliverySerializationMismatchError,
  markDeliveryDispatchStarted,pinDeliverySerializationEvidence,type ClaimedDeliveryJob,
} from "./apns-worker-state.js";
import type { DeliverySerializationEvidence } from "./delivery-serialization.js";

type ActivityTransport = "live_activity_start" | "live_activity_update";
type Queryable = { query(text: string,values?: unknown[]): Promise<{ rowCount: number | null }> };

export function nextActivityProviderTimestamp(last: number | null,nowMs: number):
  | { kind: "ready";timestamp: number }
  | { kind: "wait";untilMs: number;reason: "next_second" | "clock_rollback" } {
  const now = Math.floor(nowMs/1_000);
  if (!Number.isSafeInteger(now) || now < 0
    || (last !== null && (!Number.isSafeInteger(last) || last < 0))) throw new Error("Invalid ActivityKit clock");
  if (last === null || now > last) return { kind: "ready",timestamp: now };
  return { kind: "wait",untilMs: (last+1)*1_000,reason: now < last ? "clock_rollback" : "next_second" };
}

/** Runs in the canonical activity mutation transaction. Historical events are immutable. */
export async function retireUnsentActivityFrames(
  query: Queryable,activityId: string,deviceId: string,generation: number,sequence: number,
): Promise<void> {
  await query.query(
    `UPDATE delivery_jobs j SET state='canceled',last_error_code='activity_frame_superseded',
       last_error_message='A newer canonical activity frame replaced this unsent frame',
       claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
     FROM notification_events e WHERE e.id=j.notification_event_id
       AND j.live_activity_id=$1 AND j.device_id=$2
       AND (j.state IN ('pending','retry') OR (j.state='processing' AND j.claim_phase='preparing'))
       AND ((e.payload#>>'{liveActivity,generation}')::bigint<$3
         OR ((e.payload#>>'{liveActivity,generation}')::bigint=$3
           AND (e.payload#>>'{liveActivity,sequence}')::bigint<$4))`,
    [activityId,deviceId,generation,sequence],
  );
}

export type ActivityFramePreparation =
  | { kind: "ready";timestamp: number;transport: ActivityTransport }
  | { kind: "deferred";reason: "next_second" | "clock_rollback" | "activity_token_pending" }
  | { kind: "superseded" };

/** A short transaction pins the timestamp, payload and dispatch fence together. */
export async function prepareLatestActivityFrame(
  db: Database,job: ClaimedDeliveryJob,command: Record<string,unknown>,priority: 5 | 10,
  evidence: (timestamp: number,transport: ActivityTransport) => DeliverySerializationEvidence,
  clock?: () => number,
): Promise<ActivityFramePreparation> {
  const generation = Number(command.generation),sequence = Number(command.sequence);
  if (!job.live_activity_id || !Number.isSafeInteger(generation) || generation < 1
    || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid activity frame identity");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='250ms'");
    await client.query("SET LOCAL statement_timeout='2s'");
    // Serialize with canonical mutations, not with any provider network wait.
    const activity = (await client.query<{ generation: string;sequence: string }>(
      "SELECT generation,sequence FROM live_activities WHERE id=$1 AND principal_id=$2 FOR UPDATE",
      [job.live_activity_id,job.principal_id],
    )).rows[0];
    const owned = (await client.query<{
      activity_provider_timestamp: string | null;canonical_intent_sha256: string | null;
      transport: ActivityTransport;
    }>(
      `SELECT activity_provider_timestamp,canonical_intent_sha256,transport FROM delivery_jobs
       WHERE id=$1 AND claim_token=$2 AND state='processing' AND claim_phase='preparing' FOR UPDATE`,
      [job.id,job.claim_token],
    )).rows[0];
    if (!owned) throw new DeliveryClaimOwnershipLostError();
    if (!activity || Number(activity.generation) !== generation || Number(activity.sequence) !== sequence) {
      await client.query(
        `UPDATE delivery_jobs SET state='canceled',last_error_code='activity_frame_superseded',
           claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND claim_token=$2`,[job.id,job.claim_token],
      );
      await client.query("COMMIT");
      return { kind: "superseded" };
    }
    await retireUnsentActivityFrames(client,job.live_activity_id,job.device_id,generation,sequence);
    const dependency = (await client.query<{ token_ready: boolean;start_ready: boolean;start_fenced: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM live_activity_update_tokens t
         WHERE t.live_activity_id=$1 AND t.device_id=d.id AND t.generation=$3
           AND t.environment=d.apns_environment) AS token_ready,
         (d.live_activity_push_to_start_token IS NOT NULL AND d.revoked_at IS NULL
           AND d.live_activity_authorization='authorized') AS start_ready,
         EXISTS(SELECT 1 FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
           WHERE j.live_activity_id=$1 AND j.device_id=d.id AND j.transport='live_activity_start'
             AND e.payload#>>'{liveActivity,generation}'=$3::text
             AND j.id<>$4 AND j.last_dispatch_started_at IS NOT NULL) AS start_fenced
       FROM devices d WHERE d.id=$2`,
      [job.live_activity_id,job.device_id,generation,job.id],
    )).rows[0];
    let transport = owned.transport;
    if (!owned.canonical_intent_sha256 && command.operation !== "end") {
      if (dependency?.token_ready) transport = "live_activity_update";
      else if (dependency?.start_ready && !dependency.start_fenced) transport = "live_activity_start";
    }
    if (!(transport === "live_activity_start" ? dependency?.start_ready : dependency?.token_ready)) {
      await deferFrame(client,job,new Date(Date.now()+60_000),"activity_token_pending");
      await client.query("COMMIT");
      return { kind: "deferred",reason: "activity_token_pending" };
    }
    await client.query(
      `INSERT INTO activity_delivery_heads(live_activity_id,device_id,generation)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,[job.live_activity_id,job.device_id,generation],
    );
    const head = (await client.query<{ last_provider_timestamp: string | null }>(
      `SELECT last_provider_timestamp FROM activity_delivery_heads
       WHERE live_activity_id=$1 AND device_id=$2 AND generation=$3 FOR UPDATE`,
      [job.live_activity_id,job.device_id,generation],
    )).rows[0]!;
    // Use the database clock after acquiring locks. Injected clocks are for regression fixtures.
    const nowMs = clock ? clock() : Number((await client.query(
      "SELECT extract(epoch FROM clock_timestamp())*1000 AS milliseconds",
    )).rows[0].milliseconds);
    const pinned = owned.activity_provider_timestamp === null ? null : Number(owned.activity_provider_timestamp);
    if (owned.canonical_intent_sha256 && pinned === null) throw new DeliverySerializationMismatchError();
    const next = pinned === null
      ? nextActivityProviderTimestamp(head.last_provider_timestamp === null ? null : Number(head.last_provider_timestamp),nowMs)
      : pinned*1_000 > nowMs
        ? { kind: "wait" as const,untilMs: pinned*1_000,reason: "clock_rollback" as const }
        : { kind: "ready" as const,timestamp: pinned };
    if (next.kind === "wait") {
      await deferFrame(client,job,new Date(next.untilMs),`activity_${next.reason}`);
      await client.query("COMMIT");
      return { kind: "deferred",reason: next.reason };
    }
    await client.query(
      "UPDATE delivery_jobs SET transport=$3,activity_provider_timestamp=$4 WHERE id=$1 AND claim_token=$2",
      [job.id,job.claim_token,transport,next.timestamp],
    );
    await pinDeliverySerializationEvidence(client,job,evidence(next.timestamp,transport));
    await markDeliveryDispatchStarted(client,job.id,job.claim_token,priority);
    await client.query(
      `UPDATE activity_delivery_heads SET last_provider_timestamp=GREATEST(last_provider_timestamp,$4)
       WHERE live_activity_id=$1 AND device_id=$2 AND generation=$3`,
      [job.live_activity_id,job.device_id,generation,next.timestamp],
    );
    await client.query("COMMIT");
    return { kind: "ready",timestamp: next.timestamp,transport };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function deferFrame(query: Queryable,job: ClaimedDeliveryJob,until: Date,reason: string): Promise<void> {
  await query.query(
    `UPDATE delivery_jobs SET state='retry',available_at=$3,last_error_code=$4,
       claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE id=$1 AND claim_token=$2 AND state='processing' AND claim_phase='preparing'`,
    [job.id,job.claim_token,until,reason],
  );
}
