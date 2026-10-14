import { randomUUID } from "node:crypto";
import { resolveActivityReplay } from "../activity-lifecycle-domain.js";
import { recordActivityCorrelationDecision } from "../activity-relationships.js";
import { publicId } from "../ids.js";
import { originGenerationMetadata } from "../origin-slots.js";
import { terminalPresentationColumnsFromRow } from "../presentation-runtime.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import type { SealedNotice } from "../sealed-content.js";
import { cancelPendingActivityInteractions,createActivityCommands,serializeTaskActivity,storeSealedCard,taskActivityRequestHash } from "./runtime.js";
import type { ActivityDeliverySummary,ApnsMode } from "./schemas.js";
import { activityDeliverySummarySchema } from "./schemas.js";
import { lockActivityActor } from "./store.js";
import { startAccepted,startRejected,type ActivityStartFailure,type ActivityStartResult,type ActivityStartRow } from "./start-types.js";
import type { ActivityActor,ActivityRow,ActivitySnapshot } from "./types.js";
type Queryable=SubjectTransaction;
export async function associateServiceActivityEvents(
  query: Queryable,
  principalId: string,
  serviceId: string,
  activityId: string,
): Promise<void> {
  await query.query(
    `UPDATE notification_events SET service_id=$3
     WHERE principal_id=$1 AND payload#>>'{liveActivity,activityId}'=$2 AND service_id IS NULL`,
    [principalId,publicId("act",activityId),serviceId],
  );
}

async function cleanupServiceTerminalTokens(query: Queryable, activityId: string): Promise<void> {
  await query.query(
    `DELETE FROM live_activity_update_tokens t
     WHERE t.live_activity_id=$1 AND NOT EXISTS (
       SELECT 1 FROM delivery_jobs j
       JOIN notification_events e ON e.id=j.notification_event_id
       WHERE j.live_activity_id=t.live_activity_id AND j.device_id=t.device_id
         AND j.transport='live_activity_update'
         AND e.payload#>>'{liveActivity,operation}'='end'
     )`,
    [activityId],
  );
}

export async function replaceBlockingActivity(
  query: Queryable,
  input: { service: {id:string;principal_id:string;title:string}; activity: ActivityRow; apnsMode: ApnsMode },
): Promise<void> {
  const stored = terminalPresentationColumnsFromRow(input.activity,"Replaced","warning");
  const ended = (await query.query<ActivityRow>(
    `UPDATE live_activities SET state='replaced',title=$3,status=$4,detail=$5,progress=$6,
       symbol=$7,privacy=$8,accent_color=$9,style=$10,presentation=$11,presentation_sha256=$12,
       terminal_reason='explicit_replace',terminal_actor='service',
       terminal_policy='replacement',terminal_transition_at=now(),
       sequence=sequence+1,ended_at=now(),updated_at=now()
     WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
    [input.activity.id,input.service.principal_id,stored.title,stored.status,stored.detail,stored.progress,
      stored.symbol,stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash],
  )).rows[0];
  if (!ended) return;
  await cancelPendingActivityInteractions(query,input.service.principal_id,ended.id);
  const delivery = await createActivityCommands(query,{
    principalId: input.service.principal_id,
    sourceName: input.service.title,
    activity: ended,
    operation: "end",
    apnsMode: input.apnsMode,
    dismissAfterSeconds: 0,
  });
  if (ended.requester_service_id) {
    await associateServiceActivityEvents(query,input.service.principal_id,ended.requester_service_id,ended.id);
  }
  await cleanupServiceTerminalTokens(query,ended.id);
  const snapshot = serializeTaskActivity(ended);
  await query.query(
    `INSERT INTO live_activity_operations(
       live_activity_id,principal_id,requester_service_id,requester_credential_id,idempotency_key,
       operation,resulting_sequence,request_hash,delivery_summary,dismiss_after_seconds,activity_snapshot
     ) VALUES ($1,$2,$3,$4,$5,'end',$6,$7,$8,0,$9)`,
    [ended.id,input.service.principal_id,ended.requester_service_id ?? null,ended.requester_credential_id ?? null,
      `service:replaced:${randomUUID()}`,ended.sequence,
      taskActivityRequestHash("replaced",{ activityId: publicId("act",ended.id), sequence: Number(ended.sequence) }),
      delivery,snapshot],
  );
}


export const activityReplay=(query:Queryable,principalId:string,credentialId:string,key:string|undefined,operation:"update"|"end",hash:string)=>
 resolveActivityReplay(query,{principalId,credentialId,serviceId:null},key,operation,hash,value=>activityDeliverySummarySchema.parse(value));
export const serviceActivityReplay=(query:Queryable,principalId:string,serviceId:string,key:string|undefined,operation:"update"|"end",hash:string)=>
 resolveActivityReplay(query,{principalId,credentialId:null,serviceId},key,operation,hash,value=>activityDeliverySummarySchema.parse(value));
export async function serviceForActor(query:SubjectTransaction,actor:Extract<ActivityActor,{kind:"service"}>){
 const active=await lockActivityActor(query,actor);return active?.kind==="service"?{id:active.serviceId,principal_id:active.principalId,title:active.sourceName}:undefined;
}

/** A stored start (found by idempotency key or lifecycle run) answers its own replay. */
export function replayStoredStart(row:ActivityStartRow,hash:string,options:{
  conflict:ActivityStartFailure;disposition:boolean;includeReplaced:boolean;
}):ActivityStartResult{
  if(row.start_request_hash!==hash||!row.start_snapshot)return startRejected(options.conflict,"conflict");
  const delivery=activityDeliverySummarySchema.parse(row.start_delivery_summary);
  return startAccepted({activity:row.start_snapshot,delivery,queued:delivery.apnsJobs,
    ...(options.disposition?{disposition:"replayed"}:{}),replayed:true,...originGenerationMetadata(row,false),
    ...(options.includeReplaced&&row.start_replace_requested?{replaced:row.start_replaced_count}:{})},false);
}

/** A start that matched an earlier update operation of the same requester replays it. */
export function replayedOperation(snapshot:ActivitySnapshot,delivery:ActivityDeliverySummary,
  options:{disposition:boolean;resumed:boolean}):ActivityStartResult{
  return startAccepted({activity:snapshot,delivery,queued:delivery.apnsJobs,
    ...(options.disposition?{disposition:"replayed"}:{}),replayed:true,reused:true,resumed:options.resumed},false);
}

type CorrelationDecision=Parameters<typeof recordActivityCorrelationDecision>[1];

/** The shared tail of reusing an active card for a start: the caller has applied its UPDATE. */
export async function completeActiveCardReuse(client:Queryable,input:{
  principalId:string;requester:{kind:"credential"|"service";id:string};sourceName:string;
  activityId:string;updated:ActivityStartRow;idempotencyKey:string|undefined;requestHash:string;
  apnsMode:ApnsMode;occurredAt:string|undefined;
  correlation:Pick<CorrelationDecision,"actor"|"matchedBy"|"reason">;
  /** The start's sealed card text: stored with the presentation it describes (ADR 0007, A3). */
  sealed?:SealedNotice|undefined;
}):Promise<{snapshot:ActivitySnapshot;delivery:ActivityDeliverySummary}>{
  await cancelPendingActivityInteractions(client,input.principalId,input.activityId);
  const delivery=await createActivityCommands(client,{occurredAt:input.occurredAt,principalId:input.principalId,
    sourceName:input.sourceName,activity:await storeSealedCard(client,input.updated,input.sealed),operation:"update",apnsMode:input.apnsMode});
  if(input.requester.kind==="service"){
    await associateServiceActivityEvents(client,input.principalId,input.requester.id,input.activityId);
  }
  const snapshot=serializeTaskActivity(input.updated);
  const requesterColumn=input.requester.kind==="service"?"requester_service_id":"requester_credential_id";
  await client.query(
    `INSERT INTO live_activity_operations(
       live_activity_id,principal_id,${requesterColumn},idempotency_key,operation,
       resulting_sequence,request_hash,delivery_summary,activity_snapshot
     ) VALUES ($1,$2,$3,$4,'update',$5,$6,$7,$8)`,
    [input.activityId,input.principalId,input.requester.id,input.idempotencyKey??`server:${randomUUID()}`,
      input.updated.sequence,input.requestHash,delivery,snapshot],
  );
  await recordActivityCorrelationDecision(client,{principalId:input.principalId,activityId:input.activityId,
    outcome:"reused",...input.correlation});
  return {snapshot,delivery};
}
