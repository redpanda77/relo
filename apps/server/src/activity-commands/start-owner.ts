import { randomUUID } from "node:crypto";
import { QUESTION_SECONDS } from "../question-policy.js";
import { beginActivityTransaction } from "../activity-lifecycle-domain.js";
import { syncActivityPresentationLease } from "../activity-presentation-leases.js";
import { recordActivityCorrelationDecision,recordActivityStartEvidence } from "../activity-relationships.js";
import { sha256Hex as hashToken } from "../digest.js";
import type { Database } from "../db.js";
import { publicId } from "../ids.js";
import { dashboardTestLabOrigin,lockOriginGenerationSlot,originGenerationMetadata } from "../origin-slots.js";
import { systemPresentationPolicySnapshot } from "../presentation-policy.js";
import { presentationCommandProjection } from "../presentation-runtime.js";
import { independentSubjectKey,lockSubjectAdmission } from "../relevance/commands.js";
import { admitOrdinaryEvent } from "../relevance/ordinary-admission.js";
import { expireUnstartedDashboardDecision,recordDashboardActivityOperation } from "./dashboard-projection.js";
import { cancelPendingActivityInteractions } from "./runtime.js";
import type { ActivityStartDevice,ActivityStartRow } from "./start-types.js";
import { startAccepted,startRejected,type OwnerStartCommand,type OwnerStartResult } from "./start-types.js";
import type { ActivityActor } from "./types.js";

export async function startOwnerActivity(db:Database,actor:Extract<ActivityActor,{kind:"owner"}>,command:OwnerStartCommand):Promise<OwnerStartResult>{
  const {input,deviceId,configuration}=command;
  const account={principalId:actor.principalId},dependencies={apnsMode:command.apnsMode};
  const {idleSeconds:dashboardTestIdleTimeoutSeconds,hardSeconds:dashboardTestHardTimeoutSeconds,staleSeconds:dashboardTestStaleAfterSeconds}=command.lease;
    const testId = randomUUID();
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const device = await client.query<ActivityStartDevice>(
        `SELECT id,name,apns_token,apns_environment,notification_authorization,live_activity_authorization,
           live_activity_push_to_start_token
         FROM devices WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL FOR UPDATE`,
        [deviceId,account.principalId],
      );
      if (!device.rowCount) {
        await transaction.rollback();
        return startRejected({error: "device_not_found"},"missing");
      }
      if (device.rows[0]!.live_activity_authorization !== "authorized") {
        await transaction.rollback();
        return startRejected({error: "live_activities_not_authorized"},"conflict");
      }
      if (!["authorized", "provisional"].includes(device.rows[0]!.notification_authorization)) {
        await transaction.rollback();
        return startRejected({error: "notifications_not_authorized"},"conflict");
      }
      const originHash = dashboardTestLabOrigin(account.principalId,deviceId);
      // Test runs follow the same identity rule as every producer: source › Test Lab › run title.
      const testContext = { providerName: configuration.sourceName,project: "Test Lab",threadName: configuration.title };
      const originSlot = await lockOriginGenerationSlot<ActivityStartRow>(client,account.principalId,originHash);
      const replacedEventIds: string[] = [];
      let replaced = 0;
      const latestOrigin = originSlot.latest;
      if (latestOrigin
        && (latestOrigin.requester_service_id !== null
          || latestOrigin.requester_credential_id !== null)) {
        await transaction.rollback();
        await recordActivityCorrelationDecision(db,{
          principalId: account.principalId,
          outcome: "blocked_conflict",
          matchedBy: "origin",
          actor: "dashboard",
          reason: "active_origin_owner_conflict",
        });
        return startRejected({error: "active_origin_conflict",code: "ACTIVE_ORIGIN_CONFLICT"},"conflict");
      }
      const activeSlot = {
        rows: originSlot.active ? [originSlot.active] : [],
        rowCount: originSlot.active ? 1 : 0,
      };
      const operation: "start" | "update" = activeSlot.rowCount ? "update" : "start";
      const apnsOwnsStartAlert = dependencies.apnsMode !== "disabled"
        && device.rows[0]!.apns_environment === dependencies.apnsMode
        && Boolean(device.rows[0]!.live_activity_push_to_start_token);
      const generation = operation === "update"
        ? Number(activeSlot.rows[0]!.generation)
        : originSlot.nextGeneration;
      const activity = operation === "update" ? await client.query<ActivityStartRow>(
        `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
           accent_color=$9,privacy=$10,presentation=$11,presentation_sha256=$12,
           expires_at=LEAST(statement_timestamp()+($13*interval '1 second'),created_at+($14*interval '1 second')),
           stale_at=LEAST(statement_timestamp()+($15*interval '1 second'),created_at+($14*interval '1 second')),
           sequence=sequence+1,updated_at=statement_timestamp(),declared_at=statement_timestamp()
         WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
        [activeSlot.rows[0]!.id,account.principalId,configuration.title,configuration.status,
          configuration.detail,configuration.progress,configuration.symbol,configuration.style,
          configuration.accentColor,configuration.privacyMode,configuration.stored.presentation,
          configuration.stored.presentationHash,dashboardTestIdleTimeoutSeconds,
          dashboardTestHardTimeoutSeconds,dashboardTestStaleAfterSeconds],
      ) : await client.query<ActivityStartRow>(
        `INSERT INTO live_activities(
           principal_id,activity_key,title,status,detail,progress,symbol,style,accent_color,privacy,
           target_device_ids,start_idempotency_key,presentation,presentation_sha256,expires_at,stale_at,origin_hash,generation,
           presentation_policy,presentation_policy_source,presentation_preset_id,presentation_preset_revision,created_at,updated_at,
           producer_type,declared_at,context
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,ARRAY[$11::uuid],$12,$13,$14,
           statement_timestamp()+($15*interval '1 second'),statement_timestamp()+($16*interval '1 second'),$17,$18,$19::jsonb,'system',$20,1,statement_timestamp(),statement_timestamp(),
           'script',statement_timestamp(),
           $21::jsonb) RETURNING *`,
        [account.principalId,`dashboard-test-${testId}`,configuration.title,configuration.status,
          configuration.detail,configuration.progress,configuration.symbol,configuration.style,configuration.accentColor,
          configuration.privacyMode,deviceId,`dashboard:${testId}:activity`,configuration.stored.presentation,
          configuration.stored.presentationHash,dashboardTestIdleTimeoutSeconds,dashboardTestStaleAfterSeconds,
          originHash,generation,systemPresentationPolicySnapshot("system.dashboard.test"),"system.dashboard.test",testContext],
      );
      if (operation === "update") {
        await recordActivityCorrelationDecision(client,{
          principalId: account.principalId,
          activityId: activity.rows[0]!.id,
          outcome: "reused",
          matchedBy: "origin",
          actor: "dashboard",
          reason: "active_origin_match",
        });
      } else {
        await recordActivityStartEvidence(client,{
          principalId: account.principalId,
          activityId: activity.rows[0]!.id,
          actor: "dashboard",
          previousActivityId: originSlot.latest?.id ?? null,
          matchedBy: originSlot.latest ? "origin" : "none",
          reason: originSlot.latest ? "same_origin_generation" : "new_activity_created",
        });
      }
      const activityId = publicId("act",activity.rows[0]!.id);
      if (configuration.interactionKind) {
        await lockSubjectAdmission(client,{ principalId: account.principalId,sourceId: `account:${account.principalId}` },
          independentSubjectKey(`dashboard:${testId}:event`));
      }
      const event = await client.query<{id:string;created_at:Date}>(
         `INSERT INTO notification_events(
           principal_id,source,kind,title,body,payload,idempotency_key,target_mode,expires_at,origin_hash
         ) VALUES ($1,$2,'live_activity',$3,$4,$5,$6,'explicit',$7,$8) RETURNING id,created_at`,
        [account.principalId,configuration.sourceName,configuration.title,configuration.detail ?? "",{ context: testContext },
          `dashboard:${testId}:event`,activity.rows[0]!.expires_at,originHash],
      );
      await client.query(
        `INSERT INTO notification_event_targets(notification_event_id,device_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [event.rows[0]!.id,deviceId],
      );
      await cancelPendingActivityInteractions(client,account.principalId,activity.rows[0]!.id);
      const interactionKind = configuration.interactionKind === "approval" ? "approval"
        : configuration.interactionKind === "yes_no" ? "yes_no" : null;
      let interactionCommand: Record<string,unknown> | null = null;
      if (interactionKind) {
        const admission = await admitOrdinaryEvent(client,{
          principalId: account.principalId,sourceId: `account:${account.principalId}`,
        },{
          apnsMode: dependencies.apnsMode,kind: "decision",eventId: event.rows[0]!.id,createdAt: event.rows[0]!.created_at,
          idempotencyKey: `dashboard:${testId}:event`,intentHash: hashToken(JSON.stringify(input)),
          actionDeadlineCap: activity.rows[0]!.expires_at,
          interaction: { kind: interactionKind,prompt: configuration.detail ?? configuration.title,actionSeconds: QUESTION_SECONDS },
        });
        if (admission.kind !== "applied" || !admission.request) throw new Error("dashboard_decision_admission_failed");
        const row = admission.request;
        if (row.state === "expired") await expireUnstartedDashboardDecision(client,activity.rows[0]!);
        interactionCommand = {
          id: publicId("int",row.id), notificationId: publicId("ntf",event.rows[0]!.id),
          kind: interactionKind, state: row.state, expiresAt: row.expires_at.toISOString(),
        };
      }
      const presentationLease = await syncActivityPresentationLease(client,{
        principalId: account.principalId,
        activity: activity.rows[0]!,
        deviceId,
        operation: interactionCommand?.state === "expired" ? "end" : operation,
      });
      const presentationCommand = presentationCommandProjection(activity.rows[0]!.presentation);
      const liveActivity = {
        operation: interactionCommand?.state === "expired" ? "end" : operation,
        activityId, generation: Number(activity.rows[0]!.generation),
        priority: 10,
        targetDeviceId: input.deviceId, style: configuration.style,
        ...presentationCommand,
        sourceName: configuration.sourceName, sequence: Number(activity.rows[0]!.sequence),
        expiresAt: activity.rows[0]!.expires_at ?? null, staleAt: activity.rows[0]!.stale_at ?? null,
        alertOwner: operation === "start" || presentationLease.restartRequired
          ? (apnsOwnsStartAlert ? "apns" : "app") : "none",
        dismissAfterSeconds: null, interaction: null,
        relevanceScore: presentationLease.relevanceScore,
        presentationState: presentationLease.state,
        otherActiveCount: presentationLease.otherActiveCount,
      };
      await client.query(
        "UPDATE notification_events SET payload=$2::jsonb WHERE id=$1",
        [event.rows[0]!.id,{ context: testContext,liveActivity,
          ...(interactionCommand ? { interactionId: interactionCommand.id, interactionType: interactionKind } : {}) }],
      );
      const jobs = dependencies.apnsMode !== "disabled" && device.rows[0]!.apns_environment === dependencies.apnsMode
        && interactionCommand?.state !== "expired"
        ? await client.query(
        `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [event.rows[0]!.id,deviceId,
          operation === "start" || presentationLease.restartRequired
            ? "live_activity_start" : "live_activity_update",
          activity.rows[0]!.id],
      ) : { rowCount: 0 };
      const delivery = { eligibleDevices: 1, durableCommands: 1, apnsJobs: jobs.rowCount ?? 0 };
      await client.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",[
        event.rows[0]!.id,delivery,
      ]);
      await recordDashboardActivityOperation(client,{
        principalId: account.principalId, activity: activity.rows[0]!, operation,
        delivery, request: input,
      });
      await transaction.commit();
      return startAccepted({activity: { id: activityId, style: configuration.style, title: configuration.title,
          operation, generation: Number(activity.rows[0]!.generation),
          sequence: Number(activity.rows[0]!.sequence),
          presentationHash: configuration.stored.presentationHash,ownerKind: "dashboard_test" },presentation: configuration.presentation,transportMode: "current",eventId: publicId("ntf",event.rows[0]!.id),companionEventId: null,interaction: interactionCommand ?? null,device: { id: input.deviceId, name: device.rows[0]!.name },queued: jobs.rowCount ?? 0,delivery,...originGenerationMetadata(activity.rows[0]!,operation === "update"),disposition: operation === "update" ? "reused" : "created",replaced,replacedEventIds},operation === "start");
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally { await transaction.close(); }
}
