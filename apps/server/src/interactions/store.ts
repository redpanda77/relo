import type { SubjectTransaction } from "../relevance/commands.js";
import type { InteractionActor,ExpireCommand,InteractionRow } from "./types.js";

export async function selectOwnedInteraction(tx: SubjectTransaction,actor: InteractionActor,command: ExpireCommand,lock: boolean) {
  let scope:string,authority:string|null=null;
  switch(actor.kind) {
    case "credential": scope="e.requester_credential_id=$4";authority=actor.credentialId;break;
    case "service": scope="e.service_id=$4 AND e.requester_service_id=$4";authority=actor.serviceId;break;
    case "device": scope=`EXISTS(SELECT 1 FROM devices d WHERE d.id=$4 AND d.principal_id=r.principal_id AND d.revoked_at IS NULL)
      AND (e.target_mode='broadcast' OR EXISTS(SELECT 1 FROM notification_event_targets t WHERE t.notification_event_id=e.id AND t.device_id=$4))`;authority=actor.deviceId;break;
    case "owner": case "internal_expiry": scope="$4::uuid IS NULL";break;
  }
  return (await tx.query<InteractionRow>(`SELECT r.id,r.principal_id,r.notification_event_id,r.kind,r.state,r.expires_at,r.responded_at
    FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id AND e.principal_id=r.principal_id
    WHERE r.id=$1 AND r.notification_event_id=$2 AND r.principal_id=$3 AND ${scope}${lock?" FOR UPDATE OF r":""}`,
    [command.interactionId,command.eventId,actor.principalId,authority])).rows[0]??null;
}

/** The caller holds activity -> request locks and owns the surrounding transaction.
 * Only the database clock can expire a pending request; dispatched evidence stays. */
export async function expireLockedRequest(tx: SubjectTransaction,row: Pick<InteractionRow,"id"|"principal_id"|"notification_event_id">) {
  const expired=await tx.query(`UPDATE interaction_requests SET state='expired',responded_at=clock_timestamp()
    WHERE id=$1 AND principal_id=$2 AND notification_event_id=$3 AND state='pending' AND expires_at<=clock_timestamp() RETURNING id`,
    [row.id,row.principal_id,row.notification_event_id]);
  if(!expired.rowCount) return false;
  await tx.query("UPDATE notification_events SET state='expired',updated_at=clock_timestamp() WHERE id=$1 AND principal_id=$2 AND state='active'",[row.notification_event_id,row.principal_id]);
  await tx.query(`UPDATE delivery_jobs SET state='canceled',last_error_code='interaction_expired',
    last_error_message='The decision expired before this attempt was dispatched',
    claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE notification_event_id=$1 AND (state IN ('pending','retry') OR (state='processing' AND claim_phase='preparing'))`,[row.notification_event_id]);
  return true;
}

export type ResponseRequestRow = InteractionRow & { event_state: string; credential_version: number };
export type ResponseEvidenceRow = { id: string; interaction_request_id: string | null; notification_event_id: string;
  device_id: string; kind: string; value_matches: boolean };

export async function selectVisibleDecisionEvent(tx: SubjectTransaction,principalId: string,deviceId: string,eventId: string) {
  return Boolean((await tx.query(`SELECT e.id FROM notification_events e
    JOIN devices d ON d.id=$2 AND d.principal_id=e.principal_id AND d.revoked_at IS NULL
    WHERE e.id=$1 AND e.principal_id=$3 AND (e.target_mode='broadcast' OR EXISTS(
      SELECT 1 FROM notification_event_targets t WHERE t.notification_event_id=e.id AND t.device_id=$2))`,
    [eventId,deviceId,principalId])).rowCount);
}

export async function selectResponseRequest(tx: SubjectTransaction,actor: Extract<InteractionActor,{kind:"device"}> | import("./types.js").ActivityCapabilityActor,
  command: import("./types.js").RespondCommand,locked: boolean) {
  const capability=actor.kind==="live_activity";
  return (await tx.query<ResponseRequestRow>(`SELECT r.id,r.principal_id,r.notification_event_id,r.kind,r.state,r.expires_at,r.responded_at,
    e.state AS event_state,d.credential_version FROM interaction_requests r
    JOIN notification_events e ON e.id=r.notification_event_id AND e.principal_id=r.principal_id
    JOIN devices d ON d.id=$2 AND d.principal_id=r.principal_id AND d.revoked_at IS NULL
    WHERE e.id=$1 AND ($3::uuid IS NULL OR r.principal_id=$3)
      AND ($4::uuid IS NULL OR r.id=$4)
      AND (${capability?"d.live_activity_authorization='authorized' AND":"e.target_mode='broadcast' OR"}
        EXISTS(SELECT 1 FROM notification_event_targets t WHERE t.notification_event_id=e.id AND t.device_id=$2))
    ${locked?"FOR UPDATE OF r":""}`,
    [command.eventId,actor.deviceId,capability?null:actor.principalId,capability?command.interactionId??null:null])).rows[0]??null;
}

export async function responseEvidence(tx: SubjectTransaction,principalId: string,key: string,value: Record<string,unknown>) {
  return (await tx.query<ResponseEvidenceRow>(`SELECT id,interaction_request_id,notification_event_id,device_id,kind,value=$3::jsonb AS value_matches
    FROM interactions WHERE principal_id=$1 AND idempotency_key=$2`,[principalId,key,value])).rows[0]??null;
}

export async function acceptLockedResponse(tx: SubjectTransaction,row: InteractionRow,state: InteractionRow["state"],value: Record<string,unknown>) {
  return (await tx.query<{responded_at:Date}>(`WITH decision_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
    UPDATE interaction_requests SET state=$3::interaction_request_state,response=$4,responded_at=decision_clock.at
    FROM decision_clock WHERE id=$1 AND principal_id=$2 AND state='pending' AND expires_at>decision_clock.at
    RETURNING responded_at`,[row.id,row.principal_id,state,value])).rows[0]??null;
}

export async function insertResponseEvidence(tx: SubjectTransaction,row: InteractionRow,deviceId: string,command: import("./types.js").RespondCommand) {
  return (await tx.query<{id:string}>(`INSERT INTO interactions(principal_id,notification_event_id,interaction_request_id,device_id,kind,value,idempotency_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (principal_id,idempotency_key) DO NOTHING RETURNING id`,
    [row.principal_id,row.notification_event_id,row.id,deviceId,command.kind,command.value,command.idempotencyKey])).rows[0]??null;
}

export async function markRespondedEvent(tx: SubjectTransaction,row: InteractionRow) {
  await tx.query("UPDATE notification_events SET state='responded',updated_at=clock_timestamp() WHERE id=$1 AND principal_id=$2",[row.notification_event_id,row.principal_id]);
}
