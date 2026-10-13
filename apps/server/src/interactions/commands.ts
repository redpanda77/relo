import { verifyLiveActivityCredential } from "../live-activity-interaction.js";
import { readDecisionRelevance } from "../relevance/decisions.js";
import { selectVisibleDecisionEvent,selectResponseRequest,responseEvidence,acceptLockedResponse,insertResponseEvidence,markRespondedEvent,type ResponseRequestRow,type ResponseEvidenceRow } from "./store.js";
import type { ActivityCapabilityActor,RespondCommand,ResponseResult,InteractionRow } from "./types.js";
import type { Database } from "../db.js";
import type { ApnsMode } from "../activities.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import { lockDecisionActivity } from "../decision-lock.js";
import { settleInteractiveLiveActivity } from "../interactive-activity-lifecycle.js";
import { selectOwnedInteraction,expireLockedRequest } from "./store.js";
import type { InteractionActor,ExpireCommand,ExpiryResult } from "./types.js";

/** Adapter callers may join an existing transaction. Never invoke the database
 * owner below from an activity or response transaction. */
export async function expireInteractionInTransaction(tx: SubjectTransaction,actor: InteractionActor,command: ExpireCommand,
  apnsMode: ApnsMode): Promise<ExpiryResult> {
  if(!await selectOwnedInteraction(tx,actor,command,false)) return {kind:"not_found"};
  await lockDecisionActivity(tx,actor.principalId,command.eventId);
  const row=await selectOwnedInteraction(tx,actor,command,true);
  if(!row) return {kind:"not_found"};
  if(!await expireLockedRequest(tx,row)) return {kind:"unchanged"};
  await settleInteractiveLiveActivity(tx,{principalId:actor.principalId,notificationEventId:command.eventId,responseState:"expired",apnsMode});
  return {kind:"expired"};
}

/** Cancels a pending decision whose activity lock the caller holds; its notification and card settle as canceled. */
export async function cancelLockedInteraction(tx: SubjectTransaction,input: {
  principalId: string; interactionId: string; notificationEventId: string; apnsMode: ApnsMode;
}): Promise<void> {
  await tx.query("UPDATE interaction_requests SET state='canceled',responded_at=now() WHERE id=$1",[input.interactionId]);
  await tx.query("UPDATE notification_events SET state='canceled',updated_at=now() WHERE id=$1",[input.notificationEventId]);
  await settleInteractiveLiveActivity(tx,{principalId:input.principalId,notificationEventId:input.notificationEventId,
    responseState:"canceled",apnsMode:input.apnsMode});
}

/**
 * Serializes every answer to one decision group. Taken before any decision lock, so two surfaces
 * of the same decision answered at once wait for each other instead of deadlocking.
 */
export async function lockDecisionGroupOfEvent(tx: SubjectTransaction,eventId: string): Promise<string | null> {
  const group=(await tx.query<{decision_group_id:string}>(
    "SELECT decision_group_id FROM interaction_requests WHERE notification_event_id=$1 AND decision_group_id IS NOT NULL LIMIT 1",
    [eventId])).rows[0]?.decision_group_id??null;
  if(group) await lockDecisionGroup(tx,group);
  return group;
}

export async function lockDecisionGroup(tx: SubjectTransaction,groupId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",[`decision-group:${groupId}`]);
}

export type DecisionGroupOutcome = {
  state: "approved" | "denied" | "yes" | "no" | "replied" | "canceled"; response?: Record<string,unknown> | null;
};

/**
 * Settles the group's other pending members; the caller holds the group lock. Like one question's
 * copies on several phones, every member takes the decision, so each surface shows the real
 * outcome. "canceled" settles members when no decision was made.
 */
export async function settleDecisionGroup(tx: SubjectTransaction,input: {
  groupId: string; exceptInteractionId?: string | undefined; outcome: DecisionGroupOutcome; apnsMode: ApnsMode;
}): Promise<number> {
  const members=(await tx.query<{id:string;principal_id:string;notification_event_id:string}>(
    `SELECT id,principal_id,notification_event_id FROM interaction_requests
     WHERE decision_group_id=$1 AND state='pending' AND id IS DISTINCT FROM $2 ORDER BY id`,
    [input.groupId,input.exceptInteractionId??null])).rows;
  let settled=0;
  for(const member of members) {
    await lockDecisionActivity(tx,member.principal_id,member.notification_event_id);
    const locked=await tx.query("SELECT 1 FROM interaction_requests WHERE id=$1 AND state='pending' FOR UPDATE",[member.id]);
    if(!locked.rowCount) continue;
    if(input.outcome.state==="canceled") {
      await cancelLockedInteraction(tx,{principalId:member.principal_id,interactionId:member.id,
        notificationEventId:member.notification_event_id,apnsMode:input.apnsMode});
    } else {
      await tx.query(`UPDATE interaction_requests SET state=$2::interaction_request_state,response=$3::jsonb,
        responded_at=clock_timestamp() WHERE id=$1 AND state='pending'`,[member.id,input.outcome.state,input.outcome.response??null]);
      await tx.query("UPDATE notification_events SET state='responded',updated_at=clock_timestamp() WHERE id=$1",
        [member.notification_event_id]);
      await tx.query(`UPDATE delivery_jobs SET state='canceled',last_error_code='interaction_settled',
        last_error_message='The decision was made elsewhere',claim_token=NULL,claim_started_at=NULL,
        claim_phase=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE notification_event_id=$1 AND state IN ('pending','retry')`,[member.notification_event_id]);
      await settleInteractiveLiveActivity(tx,{principalId:member.principal_id,notificationEventId:member.notification_event_id,
        responseState:input.outcome.state,apnsMode:input.apnsMode});
    }
    settled++;
  }
  return settled;
}

export async function expireInteraction(db: Database,actor: InteractionActor,command: ExpireCommand,apnsMode: ApnsMode): Promise<ExpiryResult> {
  const tx=await db.connect();
  try {
    await tx.query("BEGIN");
    const result=await expireInteractionInTransaction(tx,actor,command,apnsMode);
    await tx.query("COMMIT");return result;
  }catch(error){await tx.query("ROLLBACK");throw error;}
  finally{tx.release();}
}

export async function respondToInteraction(db: Database,actor: InteractionActor | ActivityCapabilityActor,
  command: RespondCommand,dependencies: {apnsMode:ApnsMode;credentialDerivationSecret?:string|undefined}): Promise<ResponseResult> {
  // Owner/producer/service authority never grants the authority of a phone or a
  // signed exact ActivityKit capability, even to callers of this internal API.
  if(actor.kind!=="device"&&actor.kind!=="live_activity") return {kind:"rejected",error:"forbidden"};
  const capability=actor.kind==="live_activity";
  if(capability&&(!command.interactionId||command.kind==="answer")) return {kind:"rejected",error:"not_found"};
  const tx=await db.connect();
  const finish=async(result:ResponseResult,commit=false)=>{await tx.query(commit?"COMMIT":"ROLLBACK");return result;};
  const reject=(error:Extract<ResponseResult,{kind:"rejected"}>["error"],state?:InteractionRow["state"]):ResponseResult=>({kind:"rejected",error,...(state===undefined?{}:{state})});
  try {
    await tx.query("BEGIN");
    const group=await lockDecisionGroupOfEvent(tx,command.eventId);
    if(actor.kind==="device"&&!await selectVisibleDecisionEvent(tx,actor.principalId,actor.deviceId,command.eventId)) return await finish(reject("not_found"));
    let row:ResponseRequestRow|null=null;
    const validCapability=(request:ResponseRequestRow)=>actor.kind!=="live_activity"||Boolean(dependencies.credentialDerivationSecret
      &&verifyLiveActivityCredential(dependencies.credentialDerivationSecret,actor.credential,{
        interactionId:request.id,notificationEventId:request.notification_event_id,deviceId:actor.deviceId,principalId:request.principal_id,
        credentialVersion:Number(request.credential_version),expiresAt:request.expires_at,
      }));
    if(actor.kind==="live_activity") {
      row=await selectResponseRequest(tx,actor,command,false);
      if(!row) return await finish(reject("not_found"));
      if(!validCapability(row)) return await finish(reject("invalid_credential"));
      await lockDecisionActivity(tx,row.principal_id,command.eventId);
    } else await lockDecisionActivity(tx,actor.principalId,command.eventId);
    row=await selectResponseRequest(tx,actor,command,true);
    if(!row) return await finish(reject(capability?"not_found":"interaction_not_found"));
    if(!validCapability(row)) return await finish(reject("invalid_credential"));
    if(command.interactionId&&command.interactionId!==row.id) return await finish(reject("interaction_version_mismatch"));
    const nextState=({approve:"approved",deny:"denied",yes:"yes",no:"no",answer:"replied"} as const)[command.kind];
    const matches=row.kind==="approval"?["approved","denied"].includes(nextState):row.kind==="yes_no"?["yes","no"].includes(nextState):nextState==="replied";
    if(!matches) return await finish(reject("invalid_action"));
    const relevance=await readDecisionRelevance(tx,row.principal_id,command.eventId,command.expectedSubject);
    if(!relevance.matchesExpected) return await finish(reject("interaction_version_mismatch"));
    const exact=(evidence:ResponseEvidenceRow)=>evidence.notification_event_id===command.eventId&&evidence.device_id===actor.deviceId
      &&evidence.interaction_request_id===row!.id&&evidence.kind===command.kind&&(capability||evidence.value_matches);
    const prior=await responseEvidence(tx,row.principal_id,command.idempotencyKey,command.value);
    if(prior) return await finish(exact(prior)?{kind:"replayed",evidenceId:prior.id,interactionId:row.id,state:row.state,respondedAt:row.responded_at}:reject("idempotency_conflict"),exact(prior));
    if(relevance.evaluation?.action==="superseded") return await finish(reject(capability?"interaction_terminal":"interaction_superseded",row.state));
    if(row.state!=="pending"||row.event_state!=="active") return await finish(reject(capability?"interaction_terminal":"interaction_not_pending",row.state));
    if(relevance.evaluation&&!["available","expired"].includes(relevance.evaluation.action)) return await finish(reject(capability?"interaction_terminal":"interaction_not_pending",row.state));
    const accepted=relevance.evaluation?.action==="expired"?null:await acceptLockedResponse(tx,row,nextState,command.value);
    if(!accepted) {
      if(await expireLockedRequest(tx,row)) await settleInteractiveLiveActivity(tx,{
        principalId:row.principal_id,notificationEventId:row.notification_event_id,responseState:"expired",apnsMode:dependencies.apnsMode,
      });
      return await finish(reject(capability?"interaction_expired":"interaction_not_pending",capability?undefined:"expired"),true);
    }
    const evidence=await insertResponseEvidence(tx,row,actor.deviceId,command);
    if(!evidence) {
      const raced=await responseEvidence(tx,row.principal_id,command.idempotencyKey,command.value);
      // The request lock excludes another exact writer; a different request can
      // still win this principal-wide key. Roll back the provisional state CAS.
      if(!raced||!exact(raced)) return await finish(reject("idempotency_conflict"));
      return await finish({kind:"replayed",evidenceId:raced.id,interactionId:row.id,state:nextState,respondedAt:accepted.responded_at},true);
    }
    await markRespondedEvent(tx,row);
    await settleInteractiveLiveActivity(tx,{principalId:row.principal_id,notificationEventId:row.notification_event_id,responseState:nextState,apnsMode:dependencies.apnsMode});
    // The same decision shown elsewhere stops asking: this answer is the decision.
    if(group) await settleDecisionGroup(tx,{groupId:group,exceptInteractionId:row.id,
      outcome:{state:nextState,response:command.value},apnsMode:dependencies.apnsMode});
    return await finish({kind:"accepted",evidenceId:evidence.id,interactionId:row.id,state:nextState,respondedAt:accepted.responded_at},true);
  }catch(error){await tx.query("ROLLBACK");throw error;}
  finally{tx.release();}
}
