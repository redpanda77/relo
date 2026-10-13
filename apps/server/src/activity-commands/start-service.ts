import { randomUUID } from "node:crypto";
import { beginActivityTransaction,sameActivityTargets } from "../activity-lifecycle-domain.js";
import { recordActivityCorrelationDecision,recordActivityStartEvidence } from "../activity-relationships.js";
import type { Database } from "../db.js";
import { publicId } from "../ids.js";
import { canonicalOriginHash,lockOriginGenerationSlot,originGenerationMetadata } from "../origin-slots.js";
import { preserveActivePresentationPolicy } from "../presentation-policy.js";
import { PresentationRuntimeError,assertAccountPresentationAssets } from "../presentation-runtime.js";
import { NativeOccurrenceError,assertNativeStartChronology } from "../relevance/native-occurrence.js";
import { createActivityCommands,expireDueActivities,serializeTaskActivity } from "./runtime.js";
import { associateServiceActivityEvents,completeActiveCardReuse,replaceBlockingActivity,replayStoredStart,replayedOperation,serviceActivityReplay,serviceForActor } from "./start-store.js";
import type { ActivityStartRow } from "./start-types.js";
import { startAccepted,startRejected,type ActivityStartResult,type ProducerStartCommand } from "./start-types.js";
import { lockActivityActor } from "./store.js";
import type { ActivityActor } from "./types.js";

export async function startServiceActivity(db:Database,actor:Extract<ActivityActor,{kind:"service"}>,command:ProducerStartCommand):Promise<ActivityStartResult>{
  const {rawInput,storedPresentation,presentationPolicy,apnsMode,requestedDeviceIds:requestedIds,idempotencyKey:key,requestHash:hash}=command;
  const input={...rawInput,title:storedPresentation.title,status:storedPresentation.status,detail:storedPresentation.detail,
    progress:storedPresentation.progress,symbol:storedPresentation.symbol,style:storedPresentation.style,
    privacy:storedPresentation.privacy,privacyMode:storedPresentation.privacy,accentColor:storedPresentation.accentColor,presentation:storedPresentation.presentation};
  const service={id:actor.serviceId,principal_id:actor.principalId,title:actor.sourceName};
  if(!await lockActivityActor(db,actor))return startRejected({error:"unknown_webhook"},"missing");
    const originHash = input.origin ? canonicalOriginHash(service.principal_id,input.origin) : null;
    const existing = key ? await db.query<ActivityStartRow>(
      "SELECT * FROM live_activities WHERE requester_service_id=$1 AND start_idempotency_key=$2",
      [service.id,key],
    ) : undefined;
    if (existing?.rowCount) return replayStoredStart(existing.rows[0]!,hash,{conflict:{error:"idempotency_conflict"},disposition:false,includeReplaced:true});
    if (input.lifecycle) {
      const lifecycleExisting = await db.query<ActivityStartRow>(
        `SELECT * FROM live_activities
         WHERE requester_service_id=$1 AND requester_credential_id IS NULL
           AND lifecycle_provider=$2 AND lifecycle_run_id=$3 LIMIT 1`,
        [service.id,input.lifecycle.provider,input.lifecycle.runId],
      );
      if (lifecycleExisting.rowCount) return replayStoredStart(lifecycleExisting.rows[0]!,hash,{conflict:{error:"lifecycle_run_conflict",code:"LIFECYCLE_RUN_CONFLICT"},disposition:false,includeReplaced:false});
    }
    const originReplay = originHash
      ? await serviceActivityReplay(db,service.principal_id,service.id,key,"update",hash)
      : null;
    if (originReplay?.conflict) return startRejected({error: "idempotency_conflict"},"conflict");
    if (originReplay?.snapshot && originReplay.delivery) {
      return replayedOperation(originReplay.snapshot,originReplay.delivery,{disposition:false,resumed:false});
    }

    await expireDueActivities(db,apnsMode);
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const lockedService = await serviceForActor(client,actor);
      if (!lockedService) {
        await transaction.rollback();
        return startRejected({error: "unknown_webhook"},"missing");
      }
      await assertAccountPresentationAssets(client,lockedService.principal_id,input.presentation);
      const originSlot = originHash
        ? await lockOriginGenerationSlot<ActivityStartRow>(client,lockedService.principal_id,originHash)
        : null;
      if (!originHash) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",[lockedService.principal_id]);
      }
      if (key) {
        const concurrent = await client.query<ActivityStartRow>(
          "SELECT * FROM live_activities WHERE requester_service_id=$1 AND start_idempotency_key=$2",
          [lockedService.id,key],
        );
        if (concurrent.rowCount) {
          const response = replayStoredStart(concurrent.rows[0]!,hash,{conflict:{error:"idempotency_conflict"},disposition:false,includeReplaced:true});
          if (response.kind === "started") await transaction.commit(); else await transaction.rollback();
          return response;
        }
      }
      if (input.lifecycle) {
        const concurrentLifecycle = await client.query<ActivityStartRow>(
          `SELECT * FROM live_activities
           WHERE requester_service_id=$1 AND requester_credential_id IS NULL
             AND lifecycle_provider=$2 AND lifecycle_run_id=$3 LIMIT 1`,
          [lockedService.id,input.lifecycle.provider,input.lifecycle.runId],
        );
        if (concurrentLifecycle.rowCount) {
          const response = replayStoredStart(concurrentLifecycle.rows[0]!,hash,{conflict:{error:"lifecycle_run_conflict",code:"LIFECYCLE_RUN_CONFLICT"},disposition:false,includeReplaced:false});
          if (response.kind === "started") await transaction.commit(); else await transaction.rollback();
          return response;
        }
      }
      const devices = await client.query<{id:string}>(
        `SELECT id FROM devices WHERE principal_id=$1 AND revoked_at IS NULL
           AND live_activity_authorization='authorized'
           AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[])) ORDER BY id`,
        [lockedService.principal_id,requestedIds],
      );
      if (requestedIds && devices.rows.length !== requestedIds.length) {
        await transaction.rollback();
        return startRejected({error: "invalid_device_selection"},"invalid");
      }
      const targetIds = devices.rows.map((device: { id: string }) => device.id);
      const blockers = originSlot ? {
        rows: originSlot.active ? [originSlot.active] : [],
        rowCount: originSlot.active ? 1 : 0,
      } : await client.query<ActivityStartRow>(
        `SELECT * FROM live_activities WHERE principal_id=$1 AND state='active'
           AND presentation IS NOT NULL
           AND (($3::text IS NOT NULL AND requester_service_id=$2 AND activity_key=$3)
             OR (cardinality($4::uuid[])>0 AND target_device_ids && $4::uuid[]))
         ORDER BY created_at FOR UPDATE`,
        [lockedService.principal_id,lockedService.id,input.key ?? null,targetIds],
      );
      const latestOrigin = originSlot?.latest;
      if (latestOrigin) await assertNativeStartChronology(client,latestOrigin,input.occurredAt);
      if (latestOrigin
        && (latestOrigin.requester_service_id !== lockedService.id
          || latestOrigin.requester_credential_id !== null)) {
        await transaction.rollback();
        await recordActivityCorrelationDecision(db,{
          principalId: lockedService.principal_id,
          outcome: "blocked_conflict",
          matchedBy: "origin",
          actor: "service",
          reason: "active_origin_owner_conflict",
        });
        return startRejected({error: "active_origin_conflict",code: "ACTIVE_ORIGIN_CONFLICT"},"conflict");
      }
      if (originHash && blockers.rowCount) {
        const current = blockers.rows[0]!;
        if (current.lifecycle_run_id && (
          current.lifecycle_provider !== input.lifecycle?.provider
          || current.lifecycle_run_id !== input.lifecycle?.runId
        )) {
          await transaction.rollback();
          await recordActivityCorrelationDecision(db,{
            principalId: lockedService.principal_id,
            activityId: current.id,
            outcome: "blocked_conflict",
            matchedBy: "lifecycle",
            actor: "service",
            reason: "active_origin_run_conflict",
          });
          return startRejected({error: "active_origin_run_conflict",code: "ACTIVE_ORIGIN_RUN_CONFLICT",activityId: publicId("act",current.id)},"conflict");
        }
        if (!sameActivityTargets(current.target_device_ids,targetIds)) {
          await transaction.rollback();
          await recordActivityCorrelationDecision(db,{
            principalId: lockedService.principal_id,
            activityId: current.id,
            outcome: "blocked_conflict",
            matchedBy: "origin",
            actor: "service",
            reason: "origin_target_mismatch",
          });
          return startRejected({error: "origin_target_conflict",code: "ORIGIN_TARGET_CONFLICT",activityId: publicId("act",current.id)},"conflict");
        }
        const replay = await serviceActivityReplay(
          client,lockedService.principal_id,lockedService.id,key,"update",hash,
        );
        if (replay?.conflict) {
          await transaction.rollback();
          return startRejected({error: "idempotency_conflict"},"conflict");
        }
        if (replay?.snapshot && replay.delivery) {
          await transaction.commit();
          return replayedOperation(replay.snapshot,replay.delivery,{disposition:false,resumed:false});
        }
        if (current.resume_presentation) {
          // A question is pending on this card; reuse it untouched so the answer is never cancelled.
          await transaction.commit();
          return startAccepted({activity: serializeTaskActivity(current),delivery: {eligibleDevices: current.target_device_ids?.length ?? 0,durableCommands: 0,apnsJobs: 0},queued: 0,disposition: "reused",replayed: false,reused: true,resumed: false},false);
        }
        const activePresentation = preserveActivePresentationPolicy(
          current,rawInput,storedPresentation,
        );
        const updated = await client.query<ActivityStartRow>(
          `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
             privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
             context=COALESCE($13::jsonb,context),stale_after_seconds=$14::integer,stale_at=LEAST(LEAST(statement_timestamp(),COALESCE($20::timestamptz,statement_timestamp()))+($14::integer*interval '1 second'),expires_at),
             lifecycle_provider=COALESCE(lifecycle_provider,$15),
             lifecycle_run_id=COALESCE(lifecycle_run_id,$16),
             presentation_policy_source=COALESCE(presentation_policy_source,$17),
             presentation_preset_id=COALESCE(presentation_preset_id,$18),
             presentation_preset_revision=COALESCE(presentation_preset_revision,$19),
             sequence=sequence+1,updated_at=statement_timestamp()
           WHERE id=$1 AND requester_service_id=$2 AND state='active' RETURNING *`,
          [current.id,lockedService.id,activePresentation.title,activePresentation.status,activePresentation.detail,activePresentation.progress,activePresentation.symbol,activePresentation.style,activePresentation.privacy,activePresentation.accentColor,activePresentation.presentation,activePresentation.presentationHash,input.context ?? null,input.staleAfterSeconds,input.lifecycle?.provider ?? null,input.lifecycle?.runId ?? null,current.presentation_policy_source,current.presentation_preset_id,current.presentation_preset_revision,input.occurredAt ?? null],
        );
        const {snapshot,delivery} = await completeActiveCardReuse(client,{
          principalId: lockedService.principal_id,requester: {kind: "service",id: lockedService.id},
          sourceName: lockedService.title,activityId: current.id,updated: updated.rows[0]!,
          idempotencyKey: key,requestHash: hash,apnsMode,occurredAt: input.occurredAt,
          correlation: {actor: "service",matchedBy: input.lifecycle ? "lifecycle" : "origin",
            reason: input.lifecycle ? "active_lifecycle_match" : "active_origin_match"},
        });
        await transaction.commit();
        return startAccepted({activity: snapshot,delivery,queued: delivery.apnsJobs,replayed: false,reused: true,resumed: false},false);
      }
      if (blockers.rowCount && !input.replace) {
        await transaction.rollback();
        const owned = blockers.rows.find((row: ActivityStartRow) => row.requester_service_id === lockedService.id);
        await recordActivityCorrelationDecision(db,{
          principalId: lockedService.principal_id,
          activityId: owned?.id ?? null,
          outcome: "blocked_conflict",
          matchedBy: input.key ? "activity_key" : "current",
          actor: "service",
          reason: "active_activity_requires_replacement",
        });
        return startRejected({error: "active_activity_conflict",code: "ACTIVE_ACTIVITY_CONFLICT",...(owned ? { activityId: publicId("act",owned.id) } : {})},"conflict");
      }
      for (const blocker of input.replace ? blockers.rows : []) {
        await replaceBlockingActivity(client,{ service: lockedService, activity: blocker, apnsMode });
      }
      const startTime = Math.min(Date.now(),input.occurredAt ? Date.parse(input.occurredAt) : Date.now());
      const expiresAt = new Date(startTime+input.expiresInSeconds*1000);
      const staleAt = new Date(Math.min(startTime+input.staleAfterSeconds*1000,expiresAt.getTime()));
      const generation = originSlot?.nextGeneration ?? 1;
      const result = await client.query<ActivityStartRow>(
        `INSERT INTO live_activities(
           principal_id,requester_service_id,activity_key,title,status,detail,progress,symbol,style,privacy,accent_color,
           target_device_ids,start_idempotency_key,start_request_hash,context,expires_at,stale_at,
           start_replace_requested,start_replaced_count,presentation,presentation_sha256,origin_hash,generation,
           lifecycle_provider,lifecycle_run_id,presentation_policy,presentation_policy_source,
           presentation_preset_id,presentation_preset_revision,stale_after_seconds,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,statement_timestamp(),statement_timestamp()) RETURNING *`,
        [lockedService.principal_id,lockedService.id,input.key ?? null,input.title,input.status,input.detail ?? null,input.progress ?? null,input.symbol,input.style,storedPresentation.privacy,input.accentColor,targetIds,key ?? `server:${randomUUID()}`,hash,input.context ?? null,expiresAt,staleAt,input.replace,blockers.rows.length,input.presentation,storedPresentation.presentationHash,originHash,generation,input.lifecycle?.provider ?? null,input.lifecycle?.runId ?? null,presentationPolicy,presentationPolicy.source,presentationPolicy.presetId,presentationPolicy.presetRevision,input.staleAfterSeconds],
      );
      const delivery = await createActivityCommands(client,{ occurredAt: input.occurredAt,
        principalId: lockedService.principal_id,
        sourceName: lockedService.title,
        activity: result.rows[0]!,
        operation: "start",
        apnsMode,
        requestedDeviceIds: targetIds,
      });
      await associateServiceActivityEvents(client,lockedService.principal_id,lockedService.id,result.rows[0]!.id);
      const snapshot = serializeTaskActivity(result.rows[0]!);
      await client.query(
        "UPDATE live_activities SET start_delivery_summary=$2::jsonb,start_snapshot=$3::jsonb WHERE id=$1",
        [result.rows[0]!.id,delivery,snapshot],
      );
      await recordActivityStartEvidence(client,{
        principalId: lockedService.principal_id,
        activityId: result.rows[0]!.id,
        actor: "service",
        previousActivityId: originSlot?.latest?.id ?? null,
        supersededActivityIds: input.replace ? blockers.rows.map((row: ActivityStartRow) => row.id) : [],
        matchedBy: originSlot?.latest
          ? "origin"
          : blockers.rows.length
            ? "replacement"
            : input.lifecycle
              ? "lifecycle"
              : input.key
                ? "activity_key"
                : "none",
        reason: originSlot?.latest
          ? "same_origin_generation"
          : blockers.rows.length
            ? "explicit_replacement"
            : "new_activity_created",
      });
      await transaction.commit();
      return startAccepted({activity: snapshot,delivery,queued: delivery.apnsJobs,...originGenerationMetadata(result.rows[0]!,false),replayed: false,...(input.replace ? { replaced: blockers.rows.length } : {})},true);
    } catch (error) {
      await transaction.rollback();
      await transaction.close();
      if (error instanceof NativeOccurrenceError) return startRejected({error: error.code},error.code === "invalid_occurrence" ? "invalid" : "conflict");
      if (error instanceof PresentationRuntimeError) return startRejected({error: error.code},"conflict");
      if (key) {
        const replay = await db.query<ActivityStartRow>(
          "SELECT * FROM live_activities WHERE requester_service_id=$1 AND start_idempotency_key=$2",
          [service.id,key],
        );
        if (replay.rowCount) return replayStoredStart(replay.rows[0]!,hash,{conflict:{error:"idempotency_conflict"},disposition:false,includeReplaced:true});
      }
      if (originHash) {
        const replay = await serviceActivityReplay(
          db,service.principal_id,service.id,key,"update",hash,
        );
        if (replay?.conflict) return startRejected({error: "idempotency_conflict"},"conflict");
        if (replay?.snapshot && replay.delivery) {
          return replayedOperation(replay.snapshot,replay.delivery,{disposition:false,resumed:false});
        }
      }
      if (input.lifecycle) {
        const replay = await db.query<ActivityStartRow>(
          `SELECT * FROM live_activities
           WHERE requester_service_id=$1 AND requester_credential_id IS NULL
             AND lifecycle_provider=$2 AND lifecycle_run_id=$3 LIMIT 1`,
          [service.id,input.lifecycle.provider,input.lifecycle.runId],
        );
        if (replay.rowCount) return replayStoredStart(replay.rows[0]!,hash,{conflict:{error:"lifecycle_run_conflict",code:"LIFECYCLE_RUN_CONFLICT"},disposition:false,includeReplaced:false});
      }
      throw error;
    } finally { await transaction.close(); }
}
