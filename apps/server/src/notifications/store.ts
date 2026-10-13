import type { SubjectTransaction } from "../relevance/commands.js";
import { relevanceDeliveryGuard } from "../relevance/delivery.js";
import type { ApnsMode } from "../activities.js";
import { lockDecisionActivity } from "../decision-lock.js";
import type { NotificationActor,WithdrawNotificationCommand,CreateNotificationCommand,DeliverySummary } from "./types.js";

type WithdrawalEventRow = { id: string; withdrawn_at: Date | null };

function requester(actor: NotificationActor) {
  switch(actor.kind) {
    case "credential": return { kind: "credential",id: actor.credentialId,predicate: "requester_credential_id=$3" };
    case "service": return { kind: "service",id: actor.serviceId,predicate: "requester_service_id=$3" };
    case "owner": return { kind: "dashboard",id: actor.principalId,predicate: "$3::uuid=principal_id" };
  }
}

export async function lockWithdrawableNotification(tx: SubjectTransaction,actor: NotificationActor,eventId: string) {
  const scope=requester(actor),values=[eventId,actor.principalId,scope.id];
  const sql=`SELECT id,withdrawn_at FROM notification_events
    WHERE id=$1 AND principal_id=$2 AND ${scope.predicate} AND kind<>'live_activity'`;
  if (!(await tx.query<WithdrawalEventRow>(sql,values)).rowCount) return null;
  // Match replacement, response and expiry writers: activity -> request -> event.
  // Check authority before acquiring another actor's decision locks and again at
  // the final event lock in case a concurrent history prune removed the row.
  await lockDecisionActivity(tx,actor.principalId,eventId);
  await tx.query("SELECT id FROM interaction_requests WHERE notification_event_id=$1 ORDER BY id FOR UPDATE",[eventId]);
  return (await tx.query<WithdrawalEventRow>(`${sql} FOR UPDATE`,values)).rows[0]??null;
}

export async function persistWithdrawal(tx: SubjectTransaction,actor: NotificationActor,command: WithdrawNotificationCommand) {
  const scope=requester(actor),{eventId,idempotencyKey}=command;
  const event=(await tx.query<{withdrawn_at:Date}>(
    `UPDATE notification_events SET state='withdrawn',withdrawn_at=now(),
       withdrawn_by_kind=$3,withdrawn_by_id=$4,updated_at=now()
     WHERE id=$1 AND principal_id=$2 RETURNING withdrawn_at`,
    [eventId,actor.principalId,scope.kind,scope.id])).rows[0]!;
  await tx.query("UPDATE interaction_requests SET state='canceled',responded_at=now() WHERE notification_event_id=$1 AND state='pending'",[eventId]);
  const canceled=await tx.query(
    `UPDATE delivery_jobs SET state='canceled',updated_at=now(),last_error_code='notification_withdrawn'
     WHERE notification_event_id=$1 AND state IN ('pending','retry') RETURNING id`,[eventId]);
  const canceledDeliveries=canceled.rowCount??0,values=[actor.principalId,eventId,scope.kind,scope.id,idempotencyKey];
  await tx.query(`INSERT INTO notification_withdrawal_evidence(
    principal_id,notification_event_id,requester_kind,requester_id,idempotency_key,outcome)
    VALUES ($1,$2,$3,$4,$5,'canonical_withdrawn')`,values);
  if(canceledDeliveries>0) await tx.query(`INSERT INTO notification_withdrawal_evidence(
    principal_id,notification_event_id,requester_kind,requester_id,idempotency_key,outcome,detail_code)
    VALUES ($1,$2,$3,$4,$5,'pending_delivery_canceled',$6)`,[...values,String(canceledDeliveries)]);
  await tx.query(`INSERT INTO notification_withdrawal_evidence(
    principal_id,notification_event_id,requester_kind,requester_id,idempotency_key,device_id,outcome,detail_code)
    SELECT $1,$2,$3,$4,$5,d.id,'sync_command_queued','inbox_tombstone'
    FROM devices d WHERE d.principal_id=$1 AND d.revoked_at IS NULL`,values);
  return {withdrawnAt:event.withdrawn_at,canceledDeliveries};
}

export type CreationEventRow = {
  id: string; created_at: Date; request_hash: string | null; delivery_summary: unknown; relevance: unknown;
  interaction_id: string | null; interaction_state: string | null; interaction_expires_at: Date | null;
};

export async function eligibleNotificationDevices(tx: SubjectTransaction,actor: NotificationActor,deviceIds: string[] | null) {
  return (await tx.query<{id:string}>(`SELECT id FROM devices WHERE principal_id=$1 AND revoked_at IS NULL
    AND notification_authorization IN ('authorized','provisional') AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[])) ORDER BY id`,
    [actor.principalId,deviceIds])).rows;
}

export async function insertNotificationEvent(tx: SubjectTransaction,actor: NotificationActor,command: CreateNotificationCommand) {
  return (await tx.query<{id:string;created_at:Date}>(`INSERT INTO notification_events(
    principal_id,requester_credential_id,service_id,requester_service_id,source,kind,title,body,image_url,deep_link,payload,
    idempotency_key,expires_at,request_hash,target_mode,origin_hash)
    VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,
      CASE WHEN $12::int IS NULL THEN NULL ELSE now()+($12*interval '1 second') END,$13,$14,$15)
    ON CONFLICT DO NOTHING RETURNING id,created_at`,[
    actor.principalId,actor.kind==="credential"?actor.credentialId:null,actor.kind==="service"?actor.serviceId:null,
    command.sourceName,command.interaction?(command.interaction.kind==="approval"?"approval":"question"):"notification",
    command.title,command.content.preview,command.imageUrl,command.deepLink,command.payload,command.idempotencyKey,
    command.interaction?.actionSeconds??null,command.requestHash,command.deviceIds?"explicit":"broadcast",command.originHash,
  ])).rows[0]??null;
}

const creationReceiptColumns=`e.id,e.created_at,e.request_hash,e.delivery_summary,r.id AS interaction_id,
  r.state AS interaction_state,r.expires_at AS interaction_expires_at,
  (SELECT relevance FROM notification_relevance nr WHERE nr.notification_event_id=e.id) AS relevance`;

export async function notificationReceiptByKey(tx: SubjectTransaction,actor: NotificationActor,key: string) {
  const scope=actor.kind==="credential"?"e.requester_credential_id=$3":actor.kind==="service"
    ?"e.requester_service_id=$3 AND e.service_id=$3":"e.requester_credential_id IS NULL AND e.requester_service_id IS NULL AND $3::uuid=e.principal_id";
  return (await tx.query<CreationEventRow>(`SELECT ${creationReceiptColumns} FROM notification_events e
    LEFT JOIN interaction_requests r ON r.notification_event_id=e.id WHERE e.principal_id=$1 AND e.idempotency_key=$2 AND ${scope}`,
    [actor.principalId,key,requester(actor).id])).rows[0]??null;
}

export async function notificationReceiptById(tx: SubjectTransaction,eventId: string) {
  const row=(await tx.query<CreationEventRow>(`SELECT ${creationReceiptColumns} FROM notification_events e
    LEFT JOIN interaction_requests r ON r.notification_event_id=e.id WHERE e.id=$1`,[eventId])).rows[0];
  if(!row) throw new Error("notification_receipt_missing");
  return row;
}

export async function insertNotificationDelivery(tx: SubjectTransaction,actor: NotificationActor,eventId: string,
  deviceIds: string[] | null,apnsMode: ApnsMode) {
  if(deviceIds) await tx.query(`INSERT INTO notification_event_targets(notification_event_id,device_id)
    SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,[eventId,deviceIds]);
  // Dashboard's native text companion is constrained to the configured APNs
  // environment. Credential/service enqueue behavior retains its existing contract.
  if(actor.kind==="owner"&&apnsMode==="disabled") return 0;
  return (await tx.query(`INSERT INTO delivery_jobs(notification_event_id,device_id)
    SELECT $1,d.id FROM devices d JOIN notification_events e ON e.id=$1
    WHERE d.principal_id=$2 AND d.revoked_at IS NULL AND d.apns_token IS NOT NULL
      AND d.notification_authorization IN ('authorized','provisional')
      AND ($3::uuid[] IS NULL OR d.id=ANY($3::uuid[]))
      AND ($4::text IS NULL OR d.apns_environment::text=$4)
      AND e.state='active' AND ${relevanceDeliveryGuard("e")} ON CONFLICT DO NOTHING`,
    [eventId,actor.principalId,deviceIds,actor.kind==="owner"?apnsMode:null])).rowCount??0;
}

export async function saveNotificationDelivery(tx: SubjectTransaction,eventId: string,delivery: DeliverySummary) {
  await tx.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",[eventId,delivery]);
}
