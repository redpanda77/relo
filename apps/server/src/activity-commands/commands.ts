import { beginActivityTransaction,lifecycleMutationAllowed } from "../activity-lifecycle-domain.js";
import type { Database } from "../db.js";
import { preserveActivePresentationPolicy,resolveActivityPresentation } from "../presentation-policy.js";
import {
assertAccountPresentationAssets,canonicalPresentation,
persistedPresentationColumns,
PresentationRuntimeError,
terminalPresentationColumnsFromRow
} from "../presentation-runtime.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import { NativeOccurrenceError } from "../relevance/native-occurrence.js";
import { createDashboardActivityEvent,dashboardActivitySourceName } from "./dashboard-projection.js";
import {
boundedPresentationText,cleanupUndeliverableTerminalTokens,createActivityCommands,storeSealedCard,
serializeTaskActivity
} from "./runtime.js";
import { startCredentialActivity } from "./start-credential.js";
import { startOwnerActivity } from "./start-owner.js";
import { startServiceActivity } from "./start-service.js";
import { startRejected,type ActivityStartResult,type OwnerStartCommand,type OwnerStartResult,type ProducerStartCommand } from "./start-types.js";
import { lockActivityActor,lockCommandActivity,replayActivityCommand,saveActivityCommandReceipt,updateCommandActivity } from "./store.js";
import type { ActivityActor,ActivityCommand,ActivityCommandResult,ActivityRow } from "./types.js";
import { withdrawQuestionFallbacks } from "./question-fallback.js";

function hasMeasuredProgress(current: ActivityRow): boolean {
  const components = (current as { presentation?: { components?: Array<{ type?: string }> } }).presentation?.components;
  return Array.isArray(components) && components.some((component) => component?.type === "progress_bar");
}

function commandPresentation(actor: ActivityActor,current: ActivityRow,command: ActivityCommand) {
  const input=command.input;
  if(actor.kind==="owner") {
    if(command.operation==="end") return terminalPresentationColumnsFromRow(current,"Finished","success",{workFinished:true});
    if(!input.presentation) throw new Error("owner_activity_presentation_required");
    return persistedPresentationColumns(canonicalPresentation(input.presentation));
  }
  if(command.operation==="end") return input.presentation
    ?persistedPresentationColumns(canonicalPresentation(input.presentation))
    :terminalPresentationColumnsFromRow(current,input.status??"Complete",
      command.stopped?"stopped":input.symbol==="warning"?"warning":"success",
      {detail:input.detail,progress:input.progress,accentColor:input.accentColor,workFinished:!command.stopped,plan:command.input.plan});
  // Scripts and services update the same way (plan 10 M5): semantic fields, steps included, over the current card.
  const update=command.input;
  // A work's card with a plan carries no fraction of its own: the current step's fraction travels in the plan, so an old
  // percentage is neither carried forward nor held at its maximum beside the step count (plan 14, workstream 7).
  // Only a work's projected card (it has a work): a raw API card may use steps beside a percentage of its own.
  const planned=update.steps!==undefined&&Boolean((current as {work_id?:string|null}).work_id);
  const progress=!planned&&current.lifecycle_provider&&typeof update.progress==="number"&&typeof current.progress==="number"
    ?Math.max(update.progress,current.progress):update.progress;
  const title=boundedPresentationText(update.context?.taskTitle,80);
  const semanticInput=update.presentation?update:{...update,
    title:update.title??title??current.title,status:update.status??current.status,
    detail:update.detail!==undefined?update.detail:update.context?.threadName??current.detail,
    // Carry progress only when the card shows a measured bar; a steps card's stored progress is
    // derived from its steps and must not come back as a second, frozen bar.
    progress:progress!==undefined?progress:!planned&&hasMeasuredProgress(current)?current.progress:undefined};
  const resolved=resolveActivityPresentation(semanticInput,{principalId:actor.principalId,effective:command.policy,computerIcon:command.computerIcon});
  return preserveActivePresentationPolicy(current,semanticInput,resolved.stored);
}

/** The caller owns commit/rollback. A rejected command must roll back its
 * provisional state; an expiry outcome may intentionally request a commit. */
export async function executeActivityCommandInTransaction(tx: SubjectTransaction,actor: ActivityActor,command: ActivityCommand): Promise<{result:ActivityCommandResult;commit:boolean}> {
  const finish=(result:ActivityCommandResult,commit=false)=>({result,commit});
    const authorized=await lockActivityActor(tx,actor);
    if(!authorized) return await finish({kind:"not_found"});
    const current=await lockCommandActivity(tx,authorized,command.activityId);
    if(!current) return await finish({kind:"not_found"});
    if(actor.kind==="owner"&&(current.state!=="active"||(!current.target_device_ids?.length&&!(command.operation==="end"&&command.allowEmptyTargets))))
      return await finish({kind:"activity_not_active"});
    if(!lifecycleMutationAllowed(current,command.input.lifecycle)) return await finish({kind:"activity_owner_conflict"});
    const replay=await replayActivityCommand(tx,authorized,command);
    if(replay) return await finish(replay);
    const now=(await tx.query<{at:Date}>("SELECT clock_timestamp() AS at")).rows[0]!.at;
    if(actor.kind==="owner"&&command.operation==="update"&&current.expires_at<=now) return await finish({kind:"activity_not_active"});
    // A producer write past expires_at continues the card: time never ends work (1.7).
    if(current.state!=="active") return await finish({kind:"activity_terminal",activity:serializeTaskActivity(current)});
    if(command.input.ifSequence!==undefined&&Number(current.sequence)!==command.input.ifSequence)
      return await finish({kind:"sequence_conflict",activity:serializeTaskActivity(current)});
    // A question is on this card: keep it in front and record the work underneath, so a hook
    // or progress update never silently cancels the owner's pending answer.
    if(command.operation==="update"&&current.resume_presentation&&actor.kind!=="owner") {
      const underneath=commandPresentation(authorized,{...current,presentation:current.resume_presentation,presentation_sha256:null},command);
      await assertAccountPresentationAssets(tx,actor.principalId,underneath.presentation);
      // Its sealed text is stored with it (A3), so the card returns with matching envelopes.
      const held=(await tx.query<ActivityRow>(`UPDATE live_activities SET resume_presentation=$3::jsonb,
          context=COALESCE($4::jsonb,context),sealed=COALESCE($5::jsonb,sealed),updated_at=statement_timestamp(),
          declared_at=statement_timestamp()
        WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
      [current.id,actor.principalId,underneath.presentation,command.input.context??null,
        command.operation==="update"?command.input.sealed??null:null])).rows[0];
      if(!held) return await finish({kind:"not_found"});
      const result={kind:"applied" as const,activity:serializeTaskActivity(held),
        delivery:{eligibleDevices:held.target_device_ids?.length??0,durableCommands:0,apnsJobs:0},dismissAfterSeconds:null};
      await saveActivityCommandReceipt(tx,authorized,command,result);
      return await finish(result,true);
    }
    const stored=commandPresentation(authorized,current,command);
    await assertAccountPresentationAssets(tx,actor.principalId,stored.presentation);
    const updated=await updateCommandActivity(tx,authorized,current,command,stored);
    if(!updated) return await finish({kind:actor.kind==="owner"?"activity_not_active":"not_found"});
    // Historical owner rows with an implicit audience have no immutable target
    // command to emit. Preserve their bulk terminal settlement without rebinding.
    if(actor.kind==="owner"&&updated.target_device_ids===null) return await finish({kind:"untargeted_terminal"},true);
    // An update or end never cancels a pending question: questions reference work, never own it (1.10).
    if(current.resume_presentation) {
      await tx.query("UPDATE live_activities SET resume_presentation=NULL WHERE id=$1",[current.id]);
      await withdrawQuestionFallbacks(tx,{principalId:actor.principalId,activityId:current.id});
    }
    const dismissAfterSeconds=command.operation==="end"?command.input.dismissAfterSeconds:null;
    if(actor.kind==="owner"&&!updated.target_device_ids?.length) {
      const delivery={eligibleDevices:0,durableCommands:0,apnsJobs:0};
      const projection={eventId:null,eventIds:[],queued:0,delivery,interaction:null,interactions:[]};
      const result={kind:"applied" as const,activity:serializeTaskActivity(updated),delivery,dismissAfterSeconds,projection};
      await saveActivityCommandReceipt(tx,actor,command,result);
      return await finish(result,true);
    }
    if(actor.kind==="owner") {
      const sourceName=await dashboardActivitySourceName(tx,actor.principalId,current.id);
      const projection=await createDashboardActivityEvent(tx,{principalId:actor.principalId,activity:updated,
        operation:command.operation,deviceIds:updated.target_device_ids!,sourceName,apnsMode:command.apnsMode,
        ...(command.operation==="end"?{dismissAfterSeconds:command.input.dismissAfterSeconds}:{})});
      if(!projection.delivery.durableCommands) return await finish({kind:"activity_target_unavailable"});
      const result={kind:"applied" as const,activity:serializeTaskActivity(updated),delivery:projection.delivery,dismissAfterSeconds,projection};
      await saveActivityCommandReceipt(tx,actor,command,result);
      return await finish(result,true);
    }
    const delivery=await createActivityCommands(tx,{principalId:actor.principalId,sourceName:authorized.sourceName,
      activity:await storeSealedCard(tx,updated,command.input.sealed),operation:command.operation,apnsMode:command.apnsMode,
      occurredAt:command.input.occurredAt,dismissAfterSeconds,priority:10});
    if(command.operation==="end") await cleanupUndeliverableTerminalTokens(tx,current.id);
    const result={kind:"applied" as const,activity:serializeTaskActivity(updated),delivery,dismissAfterSeconds};
    await saveActivityCommandReceipt(tx,authorized,command,result);
    return await finish(result,true);
}

/** Owns the activity lock, canonical mutation, decision cancellation, outbox and
 * replay receipt together. Caller-owned transactions use existing settlement
 * helpers directly; they must never call this Database-owning entry point. */
export function executeActivityCommand(db: Database,actor: ActivityActor,command: OwnerStartCommand): Promise<OwnerStartResult>;
export function executeActivityCommand(db: Database,actor: ActivityActor,command: ProducerStartCommand): Promise<ActivityStartResult>;
export function executeActivityCommand(db: Database,actor: ActivityActor,command: ActivityCommand): Promise<ActivityCommandResult>;
export async function executeActivityCommand(db: Database,actor: ActivityActor,command: ActivityCommand | ProducerStartCommand | OwnerStartCommand): Promise<ActivityCommandResult | ActivityStartResult | OwnerStartResult> {
  if(command.operation==="start") {
    if(command.source==="owner") return actor.kind==="owner"?startOwnerActivity(db,actor,command):startRejected({error:"not_found"},"missing");
    if(actor.kind==="credential") return startCredentialActivity(db,actor,command);
    if(actor.kind==="service") return startServiceActivity(db,actor,command);
    return startRejected({error:"not_found"},"missing");
  }
  const transaction=await beginActivityTransaction(db);
  try {
    const outcome=await executeActivityCommandInTransaction(transaction.client,actor,command);
    if(outcome.commit) await transaction.commit();else await transaction.rollback();
    return outcome.result;
  }catch(error){
    await transaction.rollback();
    // Release before a pool-level replay query: concurrent losers must not hold
    // every pool connection while trying to acquire another one for recovery.
    await transaction.close();
    if(error instanceof NativeOccurrenceError||error instanceof PresentationRuntimeError) throw error;
    const replay=await replayActivityCommand(db,actor,command);
    if(replay) return replay;
    throw error;
  }finally{await transaction.close();}
}
