import { verifyLiveActivityCredential } from "../live-activity-interaction.js";
import { readDecisionRelevance } from "../relevance/decisions.js";
import { selectVisibleDecisionEvent,selectResponseRequest,selectBrowserResponseRequest,responseEvidence,acceptLockedResponse,insertResponseEvidence,markRespondedEvent,type ResponseRequestRow,type ResponseEvidenceRow } from "./store.js";
import type { ActivityCapabilityActor,Answerer,BrowserAnswerActor,RespondCommand,ResponseResult,InteractionRow } from "./types.js";
import type { Database } from "../db.js";
import type { ApnsMode } from "../activities.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import { settleQuestionCopies } from "./settle-copies.js";
import { askedCopy } from "../browser-answers.js";
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
  const settled=await settleQuestionCopies(tx,{
    scope:{decisionGroupId:input.groupId},
    winner:input.exceptInteractionId?{interactionId:input.exceptInteractionId}:undefined,
    outcome:{state:input.outcome.state,response:input.outcome.response??null},
    beforeSettle:async (member)=>{await lockDecisionActivity(tx,member.principalId,member.notificationEventId);},
  });
  for(const member of settled) await settleInteractiveLiveActivity(tx,{principalId:member.principalId,
    notificationEventId:member.notificationEventId,responseState:input.outcome.state,apnsMode:input.apnsMode});
  return settled.length;
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

export async function respondToInteraction(db: Database,actor: InteractionActor | ActivityCapabilityActor | BrowserAnswerActor,
  command: RespondCommand,dependencies: {apnsMode:ApnsMode;credentialDerivationSecret?:string|undefined}): Promise<ResponseResult> {
  // Owner/producer/service authority never grants the authority of a phone, a linked browser's
  // signed answer or a signed exact ActivityKit capability, even to callers of this internal API.
  if(actor.kind!=="device"&&actor.kind!=="live_activity"&&actor.kind!=="browser") return {kind:"rejected",error:"forbidden"};
  const capability=actor.kind==="live_activity";
  // A browser answers taps only (no typed replies), like the phone's buttons.
  if(actor.kind==="browser"&&command.kind==="answer") return {kind:"rejected",error:"invalid_action"};
  const answerer:Answerer=actor.kind==="browser"?{browserId:actor.browserId}:{deviceId:actor.deviceId};
  if(capability&&(!command.interactionId||command.kind==="answer")) return {kind:"rejected",error:"not_found"};
  const tx=await db.connect();
  const finish=async(result:ResponseResult,commit=false)=>{await tx.query(commit?"COMMIT":"ROLLBACK");return result;};
  const reject=(error:Extract<ResponseResult,{kind:"rejected"}>["error"],state?:InteractionRow["state"]):ResponseResult=>({kind:"rejected",error,...(state===undefined?{}:{state})});
  try {
    await tx.query("BEGIN");
    const group=await lockDecisionGroupOfEvent(tx,command.eventId);
    const overview=actor.kind==="device"&&actor.ownerOverview===true;
    if(actor.kind==="device"&&!await selectVisibleDecisionEvent(tx,actor.principalId,actor.deviceId,command.eventId,overview)) return await finish(reject("not_found"));
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
    row=actor.kind==="browser"?await selectBrowserResponseRequest(tx,actor,command,true):await selectResponseRequest(tx,actor,command,true);
    if(!row) return await finish(reject(capability?"not_found":"interaction_not_found"));
    if(!validCapability(row)) return await finish(reject("invalid_credential"));
    if(command.interactionId&&command.interactionId!==row.id) return await finish(reject("interaction_version_mismatch"));
    // An overview device has no copy of its own: like a linked browser it answers the copy the asking
    // computer waits on, whose ids the computer checks the signature over (browser-answers.ts askedCopy).
    if(overview&&await askedCopy(tx,row.principal_id,row.id)!==row.id) return await finish(reject("not_asked_copy"));
    const nextState=({approve:"approved",deny:"denied",yes:"yes",no:"no",answer:"replied",choose:"replied"} as const)[command.kind];
    // A choice is answered with one of its own options, stored as replied with that option.
    const chosen=row.kind==="choice"&&command.kind==="choose"
      ?(row.options??[]).find((option)=>option.id===command.value.optionId):undefined;
    const matches=row.kind==="approval"?["approved","denied"].includes(nextState)
      :row.kind==="yes_no"?["yes","no"].includes(nextState)
      :row.kind==="choice"?chosen!==undefined
      :command.kind==="answer";
    if(!matches) return await finish(reject("invalid_action"));
    // A phone's signature over the choice (E4.2) is kept with it so the CLI can check it.
    const signature=Object.fromEntries(Object.entries(command.value).filter(([key])=>key.startsWith("e2ee")));
    const response=chosen?{optionId:chosen.id,label:chosen.label,...signature}:command.value;
    const relevance=await readDecisionRelevance(tx,row.principal_id,command.eventId,command.expectedSubject);
    if(!relevance.matchesExpected) return await finish(reject("interaction_version_mismatch"));
    const exact=(evidence:ResponseEvidenceRow)=>evidence.notification_event_id===command.eventId
      &&(evidence.device_id??undefined)===answerer.deviceId&&(evidence.browser_id??undefined)===answerer.browserId
      &&evidence.interaction_request_id===row!.id&&evidence.kind===command.kind&&(capability||evidence.value_matches);
    const prior=await responseEvidence(tx,row.principal_id,command.idempotencyKey,command.value);
    if(prior) return await finish(exact(prior)?{kind:"replayed",evidenceId:prior.id,interactionId:row.id,state:row.state,respondedAt:row.responded_at}:reject("idempotency_conflict"),exact(prior));
    if(relevance.evaluation?.action==="superseded") return await finish(reject(capability?"interaction_terminal":"interaction_superseded",row.state));
    // A late answer from the app (1.10): stored and marked late on the expired request. It is a fact
    // for the agent, never permission (D3): the request stays expired. Live Activity buttons stay refused.
    if(!capability&&row.state==="expired") {
      const late=(await tx.query<{late_responded_at:Date}>(`UPDATE interaction_requests
        SET late_response=$2::jsonb,late_responded_at=clock_timestamp()
        WHERE id=$1 AND state='expired' AND late_response IS NULL AND owner_dismissed_at IS NULL RETURNING late_responded_at`,
      [row.id,{state:nextState,...response}])).rows[0];
      // The owner dismissed this missed question: it no longer needs them, so no late answer either.
      if(!late&&row.owner_dismissed_at) return await finish(reject("question_dismissed",row.state));
      if(!late) return await finish(reject("interaction_not_pending",row.state));
      const lateEvidence=await insertResponseEvidence(tx,row,answerer,command);
      if(!lateEvidence) return await finish(reject("idempotency_conflict"));
      return await finish({kind:"accepted",late:true,evidenceId:lateEvidence.id,interactionId:row.id,state:"expired",respondedAt:late.late_responded_at},true);
    }
    if(row.state!=="pending"||row.event_state!=="active") return await finish(reject(capability?"interaction_terminal":"interaction_not_pending",row.state));
    if(relevance.evaluation&&!["available","expired"].includes(relevance.evaluation.action)) return await finish(reject(capability?"interaction_terminal":"interaction_not_pending",row.state));
    const accepted=relevance.evaluation?.action==="expired"?null:await acceptLockedResponse(tx,row,nextState,response);
    if(!accepted) {
      if(await expireLockedRequest(tx,row)) await settleInteractiveLiveActivity(tx,{
        principalId:row.principal_id,notificationEventId:row.notification_event_id,responseState:"expired",apnsMode:dependencies.apnsMode,
      });
      return await finish(reject(capability?"interaction_expired":"interaction_not_pending",capability?undefined:"expired"),true);
    }
    const evidence=await insertResponseEvidence(tx,row,answerer,command);
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
      outcome:{state:nextState,response},apnsMode:dependencies.apnsMode});
    return await finish({kind:"accepted",evidenceId:evidence.id,interactionId:row.id,state:nextState,respondedAt:accepted.responded_at},true);
  }catch(error){await tx.query("ROLLBACK");throw error;}
  finally{tx.release();}
}
