import { randomUUID } from "node:crypto";
import { beginActivityTransaction,sameActivityTargets } from "../activity-lifecycle-domain.js";
import { recordActivityCorrelationDecision,recordActivityStartEvidence } from "../activity-relationships.js";
import type { Database } from "../db.js";
import { publicId } from "../ids.js";
import { canonicalOriginHash,lockOriginGenerationSlot,originGenerationMetadata } from "../origin-slots.js";
import { preserveActivePresentationPolicy } from "../presentation-policy.js";
import { PresentationRuntimeError,assertAccountPresentationAssets } from "../presentation-runtime.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import { NativeOccurrenceError,assertNativeStartChronology } from "../relevance/native-occurrence.js";
import { createActivityCommands,storeSealedCard,eligibleDevices,expireLockedRows,replaceBlockingTaskActivities,retireOverflowCards,serializeTaskActivity } from "./runtime.js";
import { activityReplay,completeActiveCardReuse,replayStoredStart,replayedOperation } from "./start-store.js";
import type { ActivityStartRow } from "./start-types.js";
import { startAccepted,startRejected,type ActivityStartResult,type ProducerStartCommand } from "./start-types.js";
import { lockActivityActor } from "./store.js";
import type { ActivityActor } from "./types.js";
type Queryable=SubjectTransaction;

export async function startCredentialActivity(db:Database,actor:Extract<ActivityActor,{kind:"credential"}>,command:ProducerStartCommand):Promise<ActivityStartResult>{
  const {rawInput,storedPresentation,presentationPolicy,apnsMode,requestedDeviceIds:requestedIds,idempotencyKey:key,requestHash:hash}=command;
  const input={...rawInput,title:storedPresentation.title,status:storedPresentation.status,detail:storedPresentation.detail,
    progress:storedPresentation.progress,symbol:storedPresentation.symbol,style:storedPresentation.style,
    privacy:storedPresentation.privacy,privacyMode:storedPresentation.privacy,accentColor:storedPresentation.accentColor,presentation:storedPresentation.presentation};
  const auth={principalId:actor.principalId,credentialId:actor.credentialId,clientName:actor.sourceName};
  if(!await lockActivityActor(db,actor))return startRejected({error:"not_found"},"missing");
    const originHash = input.origin ? canonicalOriginHash(auth.principalId,input.origin) : null;

    const existing = key ? await db.query<ActivityStartRow>(
      `SELECT * FROM live_activities WHERE principal_id=$1 AND requester_service_id IS NULL
         AND (requester_credential_id=$2 OR requester_credential_id IS NULL)
         AND start_idempotency_key=$3 ORDER BY (requester_credential_id=$2) DESC LIMIT 1`,
      [auth.principalId,auth.credentialId,key],
    ) : undefined;
    if (existing?.rowCount) {
      const row = existing.rows[0]!;
      if (row.requester_credential_id !== auth.credentialId) {
        return startRejected({error: "idempotency_conflict"},"conflict");
      }
      return replayStoredStart(row,hash,{conflict:{error:"idempotency_conflict"},disposition:true,includeReplaced:true});
    }
    // Run identity outlives the notification history and a producer's local cache.
    // Recognize the original admission before consulting today's active origin.
    const retainedLifecycleResponse = async (query: Queryable) => {
      if (!input.lifecycle) return null;
      const retained = await query.query<ActivityStartRow>(
        `SELECT * FROM live_activities WHERE principal_id=$1 AND requester_credential_id=$2
           AND requester_service_id IS NULL AND lifecycle_provider=$3 AND lifecycle_run_id=$4 LIMIT 1`,
        [auth.principalId,auth.credentialId,input.lifecycle.provider,input.lifecycle.runId],
      );
      const row = retained.rows[0]!;
      if (!row) return null;
      if (row.start_request_hash === hash && row.start_snapshot) {
        return replayStoredStart(row,hash,{conflict:{error:"lifecycle_run_conflict",code:"LIFECYCLE_RUN_CONFLICT"},disposition:true,includeReplaced:false});
      }
      // Active origin acquisition may intentionally update the same run. Once
      // terminal, changed intent cannot create another generation of that run.
      if (row.state !== "active" || !originHash || row.origin_hash !== originHash) {
        return startRejected({error: "lifecycle_run_conflict",code: "LIFECYCLE_RUN_CONFLICT"},"conflict");
      }
      return null;
    };
    const retainedLifecycle = await retainedLifecycleResponse(db);
    if (retainedLifecycle) return retainedLifecycle;
    const originReplay = originHash
      ? await activityReplay(db,auth.principalId,auth.credentialId,key,"update",hash)
      : null;
    if (originReplay?.conflict) return startRejected({error: "idempotency_conflict"},"conflict");
    if (originReplay?.snapshot && originReplay.delivery) {
      return replayedOperation(originReplay.snapshot,originReplay.delivery,{disposition:true,resumed:false});
    }

    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      if(!await lockActivityActor(client,actor)) {await transaction.rollback();return startRejected({error:"not_found"},"missing");}
      await assertAccountPresentationAssets(client,auth.principalId,input.presentation);
      const expireDue = async () => {
        const due = await client.query<ActivityStartRow>(
          `SELECT * FROM live_activities WHERE principal_id=$1 AND state='active' AND expires_at<=now()
             AND presentation IS NOT NULL
           ORDER BY expires_at FOR UPDATE`,
          [auth.principalId],
        );
        await expireLockedRows(client,due.rows,apnsMode);
      };
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",[auth.principalId]);
      await expireDue();
      const concurrentLifecycle = await retainedLifecycleResponse(client);
      if (concurrentLifecycle) {
        await transaction.commit();
        return concurrentLifecycle;
      }
      const originSlot = originHash
        ? await lockOriginGenerationSlot<ActivityStartRow>(client,auth.principalId,originHash)
        : null;
      const devices = await eligibleDevices(client,auth.principalId,requestedIds);
      if (requestedIds && devices.length !== requestedIds.length) {
        await transaction.rollback();
        return startRejected({error: "invalid_device_selection"},"invalid");
      }
      const blockers = await client.query<ActivityStartRow>(
        `SELECT * FROM live_activities
         WHERE principal_id=$1 AND state='active'
           AND presentation IS NOT NULL
           AND (($2::text IS NOT NULL AND requester_credential_id=$4
                 AND requester_service_id IS NULL AND activity_key=$2)
             OR (cardinality($3::uuid[])>0 AND target_device_ids && $3::uuid[]))
         ORDER BY created_at FOR UPDATE`,
        [auth.principalId,input.key ?? null,devices.map((device) => device.id),auth.credentialId],
      );
      const latestOrigin = originSlot?.latest;
      if (latestOrigin) await assertNativeStartChronology(client,latestOrigin,input.occurredAt);
      if (latestOrigin
        && (latestOrigin.requester_credential_id !== auth.credentialId
          || latestOrigin.requester_service_id !== null)) {
        await transaction.rollback();
        await recordActivityCorrelationDecision(db,{
          principalId: auth.principalId,
          outcome: "blocked_conflict",
          matchedBy: "origin",
          actor: "cli",
          reason: "active_origin_owner_conflict",
        });
        return startRejected({error: "active_origin_conflict",code: "ACTIVE_ORIGIN_CONFLICT"},"conflict");
      }
      const requestedTargets = devices.map((device) => device.id).sort();
      const convergenceCandidates = blockers.rows.filter((row: ActivityStartRow) =>
        row.requester_credential_id === auth.credentialId
        && row.requester_service_id === null
        && sameActivityTargets(row.target_device_ids,requestedTargets)
        && (originHash
          ? row.origin_hash === null && row.lifecycle_provider === null && row.lifecycle_run_id === null
            && row.activity_key === null
          : input.acquireMode === "ensure"
            && input.key === undefined),
      );
      const shouldConverge = input.acquireMode === "ensure"
        && !originSlot?.active
        && convergenceCandidates.length > 0;
      if (shouldConverge) {
        if (convergenceCandidates.length !== 1) {
          await transaction.rollback();
          await recordActivityCorrelationDecision(db,{
            principalId: auth.principalId,
            outcome: "blocked_ambiguous",
            matchedBy: originHash ? "origin" : "current",
            actor: "cli",
            reason: "multiple_current_candidates",
          });
          return startRejected({error: "activity_selection_ambiguous",code: "ACTIVITY_SELECTION_AMBIGUOUS",disposition: "blocked"},"conflict");
        }
        const current = convergenceCandidates[0]!;
        if (input.key && blockers.rows.some((row: ActivityStartRow) => row.id !== current.id
          && row.requester_credential_id === auth.credentialId
          && row.requester_service_id === null
          && row.activity_key === input.key)) {
          await transaction.rollback();
          await recordActivityCorrelationDecision(db,{
            principalId: auth.principalId,
            outcome: "blocked_conflict",
            matchedBy: "activity_key",
            actor: "cli",
            reason: "multiple_activity_key_candidates",
          });
          return startRejected({error: "owner_target_conflict",code: "OWNER_TARGET_CONFLICT",disposition: "blocked"},"conflict");
        }
        const concurrentReplay = await activityReplay(
          client,auth.principalId,auth.credentialId,key,"update",hash,
        );
        if (concurrentReplay?.conflict) {
          await transaction.rollback();
          return startRejected({error: "idempotency_conflict"},"conflict");
        }
        if (concurrentReplay?.snapshot && concurrentReplay.delivery) {
          await transaction.commit();
          return replayedOperation(concurrentReplay.snapshot,concurrentReplay.delivery,{disposition:true,resumed:Boolean(originHash)});
        }
        if (current.resume_presentation) {
          // A question is waiting on this card: keep it in front and hold this content for after the answer.
          const held = await holdUnderQuestion(client,current,preserveActivePresentationPolicy(current,rawInput,storedPresentation),input);
          await transaction.commit();
          return startAccepted({activity: serializeTaskActivity(held),delivery: {eligibleDevices: held.target_device_ids?.length ?? 0,durableCommands: 0,apnsJobs: 0},queued: 0,disposition: "reused",replayed: false,reused: true,resumed: false},false);
        }
        const activePresentation = preserveActivePresentationPolicy(
          current,rawInput,storedPresentation,
        );
        const updated = await client.query<ActivityStartRow>(
          `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
             privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
             context=COALESCE($13::jsonb,context),stale_after_seconds=$14::integer,stale_at=LEAST(LEAST(statement_timestamp(),COALESCE($23::timestamptz,statement_timestamp()))+($14::integer*interval '1 second'),expires_at),
             origin_hash=COALESCE(origin_hash,$15),
             lifecycle_provider=COALESCE(lifecycle_provider,$16),
             lifecycle_run_id=COALESCE(lifecycle_run_id,$17),
             activity_key=COALESCE(activity_key,$19),
             presentation_policy_source=COALESCE(presentation_policy_source,$20),
             presentation_preset_id=COALESCE(presentation_preset_id,$21),
             presentation_preset_revision=COALESCE(presentation_preset_revision,$22),
             sequence=sequence+1,updated_at=statement_timestamp()
           WHERE id=$1 AND principal_id=$2 AND state='active'
             AND requester_credential_id=$18 AND requester_service_id IS NULL RETURNING *`,
          [current.id,auth.principalId,activePresentation.title,activePresentation.status,activePresentation.detail,activePresentation.progress,activePresentation.symbol,activePresentation.style,activePresentation.privacy,activePresentation.accentColor,activePresentation.presentation,activePresentation.presentationHash,input.context ?? null,input.staleAfterSeconds,originHash,input.lifecycle?.provider ?? null,input.lifecycle?.runId ?? null,auth.credentialId,input.key ?? null,current.presentation_policy_source,current.presentation_preset_id,current.presentation_preset_revision,input.occurredAt ?? null],
        );
        const {snapshot,delivery} = await completeActiveCardReuse(client,{
          principalId: auth.principalId,requester: {kind: "credential",id: auth.credentialId},
          sourceName: auth.clientName ?? "Relo CLI",activityId: current.id,updated: updated.rows[0]!,
          idempotencyKey: key,requestHash: hash,apnsMode,occurredAt: input.occurredAt,
          correlation: {actor: "cli",matchedBy: originHash ? "origin" : "current",reason: originHash ? "manual_activity_adopted_by_origin" : "single_current_activity"},
        });
        await transaction.commit();
        return startAccepted({activity: snapshot,delivery,queued: delivery.apnsJobs,disposition: "reused",replayed: false,reused: true,resumed: Boolean(originHash)},false);
      }
      if (originHash && originSlot?.active) {
        const current = originSlot.active;
        if (current.lifecycle_run_id && (
          current.lifecycle_provider !== input.lifecycle?.provider
          || current.lifecycle_run_id !== input.lifecycle?.runId
        )) {
          await transaction.rollback();
          await recordActivityCorrelationDecision(db,{
            principalId: auth.principalId,
            activityId: current.id,
            outcome: "blocked_conflict",
            matchedBy: "lifecycle",
            actor: "cli",
            reason: "active_origin_run_conflict",
          });
          return startRejected({error: "active_origin_run_conflict",code: "ACTIVE_ORIGIN_RUN_CONFLICT",activityId: publicId("act",current.id)},"conflict");
        }
        const nextTargets = devices.map((device) => device.id).sort();
        if (!sameActivityTargets(current.target_device_ids,nextTargets)) {
          await transaction.rollback();
          await recordActivityCorrelationDecision(db,{
            principalId: auth.principalId,
            activityId: current.id,
            outcome: "blocked_conflict",
            matchedBy: "origin",
            actor: "cli",
            reason: "origin_target_mismatch",
          });
          return startRejected({error: "origin_target_conflict",code: "ORIGIN_TARGET_CONFLICT",activityId: publicId("act",current.id)},"conflict");
        }
        const concurrentReplay = await activityReplay(
          client,auth.principalId,auth.credentialId,key,"update",hash,
        );
        if (concurrentReplay?.conflict) {
          await transaction.rollback();
          return startRejected({error: "idempotency_conflict"},"conflict");
        }
        if (concurrentReplay?.snapshot && concurrentReplay.delivery) {
          await transaction.commit();
          return replayedOperation(concurrentReplay.snapshot,concurrentReplay.delivery,{disposition:true,resumed:false});
        }
        if (current.resume_presentation) {
          // A question is waiting on this card: keep it in front and hold this content for after the answer.
          const held = await holdUnderQuestion(client,current,preserveActivePresentationPolicy(current,rawInput,storedPresentation),input);
          await transaction.commit();
          return startAccepted({activity: serializeTaskActivity(held),delivery: {eligibleDevices: held.target_device_ids?.length ?? 0,durableCommands: 0,apnsJobs: 0},queued: 0,disposition: "reused",replayed: false,reused: true,resumed: false},false);
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
           WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
          [current.id,auth.principalId,activePresentation.title,activePresentation.status,activePresentation.detail,activePresentation.progress,activePresentation.symbol,activePresentation.style,activePresentation.privacy,activePresentation.accentColor,activePresentation.presentation,activePresentation.presentationHash,input.context ?? null,input.staleAfterSeconds,input.lifecycle?.provider ?? null,input.lifecycle?.runId ?? null,current.presentation_policy_source,current.presentation_preset_id,current.presentation_preset_revision,input.occurredAt ?? null],
        );
        const {snapshot,delivery} = await completeActiveCardReuse(client,{
          principalId: auth.principalId,requester: {kind: "credential",id: auth.credentialId},
          sourceName: auth.clientName ?? "Relo CLI",activityId: current.id,updated: updated.rows[0]!,
          idempotencyKey: key,requestHash: hash,apnsMode,occurredAt: input.occurredAt,
          correlation: {actor: "cli",matchedBy: input.lifecycle ? "lifecycle" : "origin",reason: input.lifecycle ? "active_lifecycle_match" : "active_origin_match"},
        });
        await transaction.commit();
        return startAccepted({activity: snapshot,delivery,queued: delivery.apnsJobs,disposition: "reused",replayed: false,reused: true,resumed: false},false);
      }
      if (!originHash && input.acquireMode === "ensure" && input.key) {
        const current = blockers.rows.find((row: ActivityStartRow) => row.activity_key === input.key
          && row.requester_credential_id === auth.credentialId
          && row.requester_service_id === null
          && row.lifecycle_provider === null
          && row.lifecycle_run_id === null);
        if (current) {
          const nextTargets = devices.map((device) => device.id).sort();
          if (!sameActivityTargets(current.target_device_ids,nextTargets)) {
            await transaction.rollback();
            await recordActivityCorrelationDecision(db,{
              principalId: auth.principalId,
              outcome: "blocked_conflict",
              matchedBy: "activity_key",
              actor: "cli",
              reason: "activity_key_target_mismatch",
            });
            return startRejected({error: "owner_target_conflict",code: "OWNER_TARGET_CONFLICT",disposition: "blocked"},"conflict");
          }
          const concurrentReplay = await activityReplay(
            client,auth.principalId,auth.credentialId,key,"update",hash,
          );
          if (concurrentReplay?.conflict) {
            await transaction.rollback();
            return startRejected({error: "idempotency_conflict"},"conflict");
          }
          if (concurrentReplay?.snapshot && concurrentReplay.delivery) {
            await transaction.commit();
            return replayedOperation(concurrentReplay.snapshot,concurrentReplay.delivery,{disposition:true,resumed:false});
          }
          if (current.resume_presentation) {
            // A question is waiting on this card: keep it in front and hold this content for after the answer.
            const held = await holdUnderQuestion(client,current,preserveActivePresentationPolicy(current,rawInput,storedPresentation),input);
            await transaction.commit();
            return startAccepted({activity: serializeTaskActivity(held),delivery: {eligibleDevices: held.target_device_ids?.length ?? 0,durableCommands: 0,apnsJobs: 0},queued: 0,disposition: "reused",replayed: false,reused: true,resumed: false},false);
          }
          const activePresentation = preserveActivePresentationPolicy(
            current,rawInput,storedPresentation,
          );
          const updated = await client.query<ActivityStartRow>(
            `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
               privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
               context=COALESCE($13::jsonb,context),stale_after_seconds=$14::integer,stale_at=LEAST(LEAST(statement_timestamp(),COALESCE($18::timestamptz,statement_timestamp()))+($14::integer*interval '1 second'),expires_at),
               presentation_policy_source=COALESCE(presentation_policy_source,$15),
               presentation_preset_id=COALESCE(presentation_preset_id,$16),
               presentation_preset_revision=COALESCE(presentation_preset_revision,$17),
               sequence=sequence+1,updated_at=statement_timestamp()
             WHERE id=$1 AND principal_id=$2 AND state='active'
               AND lifecycle_provider IS NULL AND lifecycle_run_id IS NULL RETURNING *`,
            [current.id,auth.principalId,activePresentation.title,activePresentation.status,activePresentation.detail,activePresentation.progress,activePresentation.symbol,activePresentation.style,activePresentation.privacy,activePresentation.accentColor,activePresentation.presentation,activePresentation.presentationHash,input.context ?? null,input.staleAfterSeconds,current.presentation_policy_source,current.presentation_preset_id,current.presentation_preset_revision,input.occurredAt ?? null],
          );
          const {snapshot,delivery} = await completeActiveCardReuse(client,{
            principalId: auth.principalId,requester: {kind: "credential",id: auth.credentialId},
            sourceName: auth.clientName ?? "Relo CLI",activityId: current.id,updated: updated.rows[0]!,
            idempotencyKey: key,requestHash: hash,apnsMode,occurredAt: input.occurredAt,
            correlation: {actor: "cli",matchedBy: "activity_key",reason: "active_activity_key_match"},
          });
          await transaction.commit();
          return startAccepted({activity: snapshot,delivery,queued: delivery.apnsJobs,disposition: "reused",replayed: false,reused: true,resumed: false},false);
        }
      }
      const blockingRows = originHash
        ? blockers.rows.filter((row: ActivityStartRow) => Boolean(input.key)
          && row.requester_credential_id === auth.credentialId
          && row.requester_service_id === null
          && row.activity_key === input.key)
        : input.key
          ? blockers.rows.filter((row: ActivityStartRow) => row.requester_credential_id === auth.credentialId
            && row.requester_service_id === null
            && row.activity_key === input.key)
          : blockers.rows;
      if (blockingRows.length && !input.replace) {
        await transaction.rollback();
        const first = blockingRows[0]!;
        const sameManualOwner = !originHash && Boolean(input.key)
          && first.requester_credential_id === auth.credentialId
          && first.requester_service_id === null
          && first.activity_key === input.key
          && first.lifecycle_provider === null
          && first.lifecycle_run_id === null;
        await recordActivityCorrelationDecision(db,{
          principalId: auth.principalId,
          activityId: sameManualOwner ? first.id : null,
          outcome: "blocked_conflict",
          matchedBy: input.key ? "activity_key" : "current",
          actor: "cli",
          reason: "active_activity_requires_replacement",
        });
        return startRejected({error: "active_activity_conflict",code: "ACTIVE_ACTIVITY_CONFLICT",disposition: "blocked",...(sameManualOwner
            ? { activityId: publicId("act",first.id) } : {})},"conflict");
      }
      const replaced = input.replace && blockingRows.length
        ? await replaceBlockingTaskActivities(client,{
          principalId: auth.principalId,
          sourceName: auth.clientName ?? "Relo CLI",
          blockerIds: blockingRows.map((row: ActivityStartRow) => row.id),
          apnsMode,
        })
        : 0;
      await retireOverflowCards(client,auth.principalId,devices.map((device) => device.id),apnsMode);
      const storedKey = key ?? `server:${randomUUID()}`;
      const privacy = storedPresentation.privacy;
      const startTime = Math.min(Date.now(),input.occurredAt ? Date.parse(input.occurredAt) : Date.now());
      const expiresAt = new Date(startTime+input.expiresInSeconds*1000);
      const staleAt = new Date(Math.min(
        startTime+input.staleAfterSeconds*1000,
        expiresAt.getTime(),
      ));
      const generation = originSlot?.nextGeneration ?? 1;
      const result = await client.query<ActivityStartRow>(
        `INSERT INTO live_activities(
           principal_id,requester_credential_id,activity_key,title,status,detail,progress,symbol,style,privacy,accent_color,
           target_device_ids,start_idempotency_key,start_request_hash,context,expires_at,stale_at,
           start_replace_requested,start_replaced_count,presentation,presentation_sha256,origin_hash,generation,
           lifecycle_provider,lifecycle_run_id,presentation_policy,presentation_policy_source,
           presentation_preset_id,presentation_preset_revision,stale_after_seconds,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,statement_timestamp(),statement_timestamp()) RETURNING *`,
        [auth.principalId,auth.credentialId,input.key ?? null,input.title,input.status,input.detail ?? null,input.progress ?? null,input.symbol,input.style,privacy,input.accentColor,devices.map((device) => device.id),storedKey,hash,input.context ?? null,expiresAt,staleAt,input.replace,replaced,input.presentation,storedPresentation.presentationHash,originHash,generation,input.lifecycle?.provider ?? null,input.lifecycle?.runId ?? null,presentationPolicy,presentationPolicy.source,presentationPolicy.presetId,presentationPolicy.presetRevision,input.staleAfterSeconds],
      );
      const delivery = await createActivityCommands(client,{
        occurredAt: input.occurredAt,
        principalId: auth.principalId,
        sourceName: auth.clientName ?? "Relo CLI",
        activity: await storeSealedCard(client,result.rows[0]!,rawInput.sealed),
        operation: "start",
        apnsMode,
        requestedDeviceIds: devices.map((device) => device.id),
      });
      const snapshot = serializeTaskActivity(result.rows[0]!);
      await client.query(
        "UPDATE live_activities SET start_delivery_summary=$2::jsonb,start_snapshot=$3::jsonb WHERE id=$1",
        [result.rows[0]!.id,delivery,snapshot],
      );
      await recordActivityStartEvidence(client,{
        principalId: auth.principalId,
        activityId: result.rows[0]!.id,
        actor: "cli",
        previousActivityId: originSlot?.latest?.id ?? null,
        supersededActivityIds: blockingRows.map((row: ActivityStartRow) => row.id),
        matchedBy: originSlot?.latest
          ? "origin"
          : blockingRows.length
            ? "replacement"
            : input.key
              ? "activity_key"
              : "none",
        reason: originSlot?.latest
          ? "same_origin_generation"
          : blockingRows.length
            ? "explicit_replacement"
            : "new_activity_created",
      });
      await transaction.commit();
      return startAccepted({activity: snapshot,delivery,queued: delivery.apnsJobs,replayed: false,disposition: replaced > 0 ? "replaced" : "created",...originGenerationMetadata(result.rows[0]!,false),...(input.replace ? { replaced } : {})},true);
    } catch (error) {
      await transaction.rollback();
      await transaction.close();
      if (error instanceof NativeOccurrenceError) return startRejected({error: error.code},error.code === "invalid_occurrence" ? "invalid" : "conflict");
      if (error instanceof PresentationRuntimeError) return startRejected({error: error.code},"conflict");
      if (key) {
        const replay = await db.query<ActivityStartRow>(
          `SELECT * FROM live_activities WHERE principal_id=$1 AND requester_service_id IS NULL
             AND (requester_credential_id=$2 OR requester_credential_id IS NULL)
             AND start_idempotency_key=$3 ORDER BY (requester_credential_id=$2) DESC LIMIT 1`,
          [auth.principalId,auth.credentialId,key],
        );
        if (replay.rowCount) {
          const row = replay.rows[0]!;
          if (row.requester_credential_id !== auth.credentialId) {
            return startRejected({error: "idempotency_conflict"},"conflict");
          }
          return replayStoredStart(row,hash,{conflict:{error:"idempotency_conflict"},disposition:true,includeReplaced:true});
        }
      }
      if (originHash) {
        const replay = await activityReplay(db,auth.principalId,auth.credentialId,key,"update",hash);
        if (replay?.conflict) return startRejected({error: "idempotency_conflict"},"conflict");
        if (replay?.snapshot && replay.delivery) {
          return replayedOperation(replay.snapshot,replay.delivery,{disposition:true,resumed:false});
        }
      }
      const keyed = input.key
        ? await db.query(
          `SELECT 1 FROM live_activities WHERE principal_id=$1 AND requester_credential_id=$2
             AND requester_service_id IS NULL AND activity_key=$3 AND state='active'
           AND presentation IS NOT NULL`,
          [auth.principalId,auth.credentialId,input.key],
        )
        : { rowCount: 0 };
      if (keyed.rowCount) return startRejected({error: "activity_key_conflict"},"conflict");
      throw error;
    } finally { await transaction.close(); }
}

/** Stores a start's content under a waiting question; the card shows it once the question settles. */
async function holdUnderQuestion(client:Queryable,current:ActivityStartRow,
  held:ReturnType<typeof preserveActivePresentationPolicy>,input:{context?:unknown;staleAfterSeconds?:number}):Promise<ActivityStartRow>{
  const row=(await client.query<ActivityStartRow>(
    `UPDATE live_activities SET resume_presentation=$3::jsonb,context=COALESCE($4::jsonb,context),
       stale_after_seconds=COALESCE($5::integer,stale_after_seconds),updated_at=statement_timestamp()
     WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
    [current.id,current.principal_id,held.presentation,input.context ?? null,input.staleAfterSeconds ?? null])).rows[0];
  return row ?? current;
}
