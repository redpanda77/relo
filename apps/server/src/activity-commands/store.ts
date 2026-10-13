import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveActivityReplay } from "../activity-lifecycle-domain.js";
import { publicId } from "../ids.js";
import type { persistedPresentationColumns } from "../presentation-runtime.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import type { ActivityActor,ActivityCommand,ActivityCommandResult,ActivityRow } from "./types.js";

const deliverySchema=z.object({eligibleDevices:z.number().int().nonnegative(),durableCommands:z.number().int().nonnegative(),apnsJobs:z.number().int().nonnegative()}).strict();
export function activityOwner(actor: ActivityActor) {
  return {principalId:actor.principalId,credentialId:actor.kind==="credential"?actor.credentialId:null,
    serviceId:actor.kind==="service"?actor.serviceId:null};
}

export async function lockActivityActor(tx: SubjectTransaction,actor: ActivityActor): Promise<ActivityActor | null> {
  if(actor.kind==="owner") return actor;
  if(actor.kind==="service") {
    const row=(await tx.query<{title:string}>(`SELECT title FROM webhook_services
      WHERE id=$1 AND principal_id=$2 AND secret_hash=$3 AND revoked_at IS NULL FOR SHARE`,
    [actor.serviceId,actor.principalId,actor.secretHash])).rows[0];
    return row?{...actor,sourceName:row.title}:null;
  }
  const row=await tx.query(`SELECT id FROM principal_api_keys
    WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL FOR SHARE`,[actor.credentialId,actor.principalId]);
  return row.rowCount?actor:null;
}

export async function lockCommandActivity(tx: SubjectTransaction,actor: ActivityActor,activityId: string): Promise<ActivityRow | undefined> {
  const owner=activityOwner(actor);
  return (await tx.query<ActivityRow>(`SELECT * FROM live_activities
    WHERE id=$1 AND principal_id=$2 AND requester_credential_id IS NOT DISTINCT FROM $3::uuid
      AND requester_service_id IS NOT DISTINCT FROM $4::uuid AND presentation IS NOT NULL FOR UPDATE`,
  [activityId,owner.principalId,owner.credentialId,owner.serviceId])).rows[0];
}

export async function replayActivityCommand(tx: SubjectTransaction,actor: ActivityActor,command: ActivityCommand): Promise<ActivityCommandResult | null> {
  if(actor.kind==="owner") return null;
  const replay=await resolveActivityReplay(tx,activityOwner(actor),command.idempotencyKey,command.operation,command.requestHash,value=>deliverySchema.parse(value));
  if(replay?.conflict) return {kind:"idempotency_conflict"};
  if(!replay?.snapshot||!replay.delivery) return null;
  return {kind:"replayed",activity:replay.snapshot,delivery:replay.delivery,dismissAfterSeconds:replay.dismissAfterSeconds??null};
}

export async function updateCommandActivity(tx: SubjectTransaction,actor: ActivityActor,current: ActivityRow,
  command: ActivityCommand,stored: ReturnType<typeof persistedPresentationColumns>): Promise<ActivityRow | undefined> {
  const owner=activityOwner(actor),values=[current.id,actor.principalId,stored.title,stored.status,stored.detail,stored.progress,
    stored.symbol,stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash];
  if(actor.kind==="owner") {
    if(command.operation==="update") {
      const lease=command.ownerLease;
      if(!lease) throw new Error("owner_activity_lease_required");
      return (await tx.query<ActivityRow>(`UPDATE live_activities SET
        title=$3,status=$4,detail=$5,progress=$6,symbol=$7,privacy=$8,accent_color=$9,style=$10,presentation=$11,presentation_sha256=$12,
        expires_at=LEAST(statement_timestamp()+($13*interval '1 second'),created_at+($14::integer*interval '1 second')),
        stale_at=LEAST(statement_timestamp()+($15*interval '1 second'),created_at+($14::integer*interval '1 second')),
        sequence=sequence+1,updated_at=statement_timestamp()
        WHERE id=$1 AND principal_id=$2 AND state='active' AND expires_at>statement_timestamp()
          AND requester_credential_id IS NULL AND requester_service_id IS NULL RETURNING *`,
      [...values,lease.idleSeconds,lease.hardSeconds,lease.staleSeconds])).rows[0];
    }
    return (await tx.query<ActivityRow>(`UPDATE live_activities SET state='ended',
      title=$3,status=$4,detail=$5,progress=$6,symbol=$7,privacy=$8,accent_color=$9,style=$10,presentation=$11,presentation_sha256=$12,
      sequence=sequence+1,ended_at=statement_timestamp(),updated_at=statement_timestamp()
      WHERE id=$1 AND principal_id=$2 AND state='active'
        AND requester_credential_id IS NULL AND requester_service_id IS NULL RETURNING *`,values)).rows[0];
  }
  if(command.operation==="update") {
    let previousStaleSeconds=current.stale_after_seconds;
    if(previousStaleSeconds==null) {
      // Activities started without a cadence (Test Lab, interaction companions) derive one
      // from their admitted occurrence when that evidence describes the current write.
      const prior=(await tx.query<{base:Date}>(`SELECT LEAST(COALESCE(occurred_at,accepted_at),accepted_at) AS base
        FROM activity_mutation_freshness WHERE activity_id=$1 AND sequence=$2 AND accepted_at=$3`,
      [current.id,current.sequence,current.updated_at])).rows[0];
      const base=prior?.base??current.updated_at;
      previousStaleSeconds=current.stale_at?Math.max(0,Math.min(28_800,Math.round((current.stale_at.getTime()-base.getTime())/1000))):14_400;
    }
    return (await tx.query<ActivityRow>(`UPDATE live_activities SET
      title=$3,status=$4,detail=$5,progress=$6,symbol=$7,privacy=$8,accent_color=$9,style=$10,presentation=$11,presentation_sha256=$12,
      context=CASE WHEN $13::jsonb IS NULL THEN context ELSE COALESCE(context,'{}'::jsonb)||$13::jsonb END,
      stale_after_seconds=$14::integer,stale_at=LEAST(LEAST(statement_timestamp(),COALESCE($17::timestamptz,statement_timestamp()))+($14::integer*interval '1 second'),expires_at),sequence=sequence+1,updated_at=statement_timestamp()
      WHERE id=$1 AND principal_id=$2 AND state='active'
        AND requester_credential_id IS NOT DISTINCT FROM $15::uuid AND requester_service_id IS NOT DISTINCT FROM $16::uuid RETURNING *`,
    [...values,command.input.context??null,command.input.staleAfterSeconds??previousStaleSeconds,owner.credentialId,owner.serviceId,command.input.occurredAt??null])).rows[0];
  }
  const terminalActor=actor.kind==="service"?"service":command.input.lifecycle?`provider:${command.input.lifecycle.provider}`:"credential";
  return (await tx.query<ActivityRow>(`UPDATE live_activities SET state='ended',
    title=$3,status=$4,detail=$5,progress=$6,symbol=$7,privacy=$8,accent_color=$9,style=$10,presentation=$11,presentation_sha256=$12,
    terminal_reason='explicit_end',terminal_actor=$13,terminal_policy='producer_terminal',terminal_transition_at=statement_timestamp(),
    sequence=sequence+1,ended_at=statement_timestamp(),updated_at=statement_timestamp()
    WHERE id=$1 AND principal_id=$2 AND state='active'
      AND requester_credential_id IS NOT DISTINCT FROM $14::uuid AND requester_service_id IS NOT DISTINCT FROM $15::uuid RETURNING *`,
  [...values,terminalActor,owner.credentialId,owner.serviceId])).rows[0];
}

export async function saveActivityCommandReceipt(tx: SubjectTransaction,actor: ActivityActor,command: ActivityCommand,
  result: Extract<ActivityCommandResult,{kind:"applied" | "replayed"}>): Promise<void> {
  const owner=activityOwner(actor);
  if(actor.kind==="service") await tx.query(`UPDATE notification_events SET service_id=$3
    WHERE principal_id=$1 AND payload#>>'{liveActivity,activityId}'=$2 AND service_id IS NULL`,
  [actor.principalId,publicId("act",command.activityId),actor.serviceId]);
  await tx.query(`INSERT INTO live_activity_operations(
    live_activity_id,principal_id,requester_credential_id,requester_service_id,idempotency_key,operation,resulting_sequence,
    request_hash,delivery_summary,dismiss_after_seconds,activity_snapshot
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [command.activityId,actor.principalId,owner.credentialId,owner.serviceId,actor.kind==="owner"?`dashboard:${randomUUID()}:${command.operation}`:command.idempotencyKey??`server:${randomUUID()}`,
    command.operation,result.activity.sequence,command.requestHash,result.delivery,result.dismissAfterSeconds,result.activity]);
}
