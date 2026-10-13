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
    return await finish({kind:"accepted",evidenceId:evidence.id,interactionId:row.id,state:nextState,respondedAt:accepted.responded_at},true);
  }catch(error){await tx.query("ROLLBACK");throw error;}
  finally{tx.release();}
}
