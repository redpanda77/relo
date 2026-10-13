import { RUN_CARD_EVIDENCE_SQL,cardEvidence } from "./run-evidence.js";
import { QUESTION_MAX_CHARACTERS } from "../question-policy.js";
import {
LIVE_ACTIVITY_PRESET_IDS,

liveActivityPresentationSchema,
type LiveActivityPresentation } from "@relo/notification-contracts";
import type { Hono } from "hono";

import { z } from "zod";

import {

liveActivityStyles,serializeTaskActivity,
taskActivityRequestHash } from "../activities.js";
import { executeActivityCommand,executeActivityCommandInTransaction } from "../activity-commands/commands.js";
import { createDashboardActivityEvent,dashboardActivitySourceName,recordDashboardActivityOperation } from "../activity-commands/dashboard-projection.js";
import { foldQuestionIntoCard } from "../activity-commands/fold-question.js";
import { QUESTION_SECONDS } from "../question-policy.js";
import { beginActivityTransaction } from "../activity-lifecycle-domain.js";

import { internalId,publicId } from "../ids.js";

import {
ActivityPrivacyPolicyError,
applyActivityPrivacyPolicy,
loadAccountPresentationPolicy,

resolveActivityPresentation,

type EffectivePresentationPolicy } from "../presentation-policy.js";
import {
canonicalPresentation,
persistedPresentationColumns
} from "../presentation-runtime.js";

import { getOwnerAccount } from "./owner-account.js";
import type { WebRouteContext } from "./route-context.js";

export const liveActivityGallery = {
  standard: { label: "Standard", headline: "Release #42", status: "Building", detail: "Compiling the Relo notification pipeline", progress: 0.42 },
  ring: { label: "Ring", headline: "Release #42", status: "Building", detail: "Compiling the Relo notification pipeline", progress: 0.65 },
  hero: { label: "Hero", headline: "Release #42", status: "Building", detail: "Compiling the Relo notification pipeline", progress: 0.42 },
  terminal: { label: "Terminal", headline: "Release #42", status: "building", detail: "Compiling the Relo notification pipeline", progress: 0.42 },
  steps: { label: "Steps", headline: "Release #42", status: "Step 3 of 5", detail: "Testing notification delivery", progress: 0.6 },
  approval: { label: "Approval", headline: "Approval needed", status: "Review", detail: "Deploy release #42 to Relo server?", progress: null },
  shell: { label: "Shell", headline: "Approval needed", status: "Awaiting", detail: "Deploy release #42 to Relo server?", progress: null },
  verdict: { label: "Verdict", headline: "Decision required", status: "Review", detail: "Deploy release #42 to Relo server?", progress: null },
  signal: { label: "Signal", headline: "Guarded action", status: "Urgent", detail: "Deploy release #42 to Relo server?", progress: null },
} satisfies Record<(typeof liveActivityStyles)[number], { label: string; headline: string; status: string; detail: string; progress: number | null }>;

const liveActivityTestSchema = z.object({
  deviceId: z.string(),presentation: liveActivityPresentationSchema,
  allowParallel: z.boolean().default(false),
}).strict();

const dashboardTestStaleAfterSeconds = 30;
const dashboardTestIdleTimeoutSeconds = 2 * 60;
const dashboardTestHardTimeoutSeconds = 10 * 60;

function resolveDashboardActivityConfiguration(
  input: z.infer<typeof liveActivityTestSchema>,
  effective: EffectivePresentationPolicy,
  principalId: string,
) {
  const resolved = resolveActivityPresentation({
    presentation: input.presentation,
    context: { project: "Relo",threadName: "Dashboard Test Lab" },
  },{ principalId,effective });
  const stored = resolved.stored;
  const interactionKind: "approval"|"yes_no"|null = stored.presentation.behavior.type === "approval" ? "approval"
    : stored.presentation.behavior.type === "yes_no" ? "yes_no" : null;
  return {
    style: stored.style as (typeof liveActivityStyles)[number],
    sourceName: stored.presentation.content.header ?? "Relo Test Lab",
    accentColor: stored.accentColor,
    title: stored.title,
    headline: stored.title,
    detail: stored.detail,
    status: stored.status,
    progress: stored.progress,
    interactionKind,
    primaryLabel: stored.presentation.behavior.type === "approval"
      || stored.presentation.behavior.type === "yes_no"
      ? stored.presentation.behavior.primary.label : null,
    secondaryLabel: stored.presentation.behavior.type === "approval"
      || stored.presentation.behavior.type === "yes_no"
      ? stored.presentation.behavior.secondary.label : null,
    symbol: stored.symbol,
    privacyMode: stored.privacy,
    presentation: stored.presentation,
    stored,
    transportMode: "current" as const,
  };
}

export function dashboardBuilderPresetPresentation(
  style: (typeof LIVE_ACTIVITY_PRESET_IDS)[number],
): LiveActivityPresentation {
  const sample = liveActivityGallery[style];
  const interactionKind = galleryInteractionKind(style);
  const component = sample.progress === null || interactionKind
    ? null
    : { id: "progress",type: "progress_bar" as const,colorRole: "project" as const,
        value: sample.progress,label: null };
  const behavior = interactionKind === "approval"
    ? { type: "approval" as const,primary: { action: "approve" as const,label: "Approve" },
        secondary: { action: "deny" as const,label: "Deny" } }
    : interactionKind === "yes_no"
      ? { type: "yes_no" as const,primary: { action: "yes" as const,label: "Yes" },
          secondary: { action: "no" as const,label: "No" } }
      : component ? { type: "progress" as const } : { type: "informational" as const };
  return canonicalPresentation({
    content: { header: "Relo",title: sample.headline,subtitle: sample.detail,status: sample.status },
    identity: { project: null,thread: null,direct: true },
    state: interactionKind
      ? { kind: "needs_action",tone: "attention",icon: "needs_action" }
      : { kind: "active",tone: "live",icon: "active" },
    components: component ? [component] : [],
    surfaces: {
      lock_screen: component ? [component.id] : [],expanded_leading: [],
      expanded_trailing: component ? [component.id] : [],
      expanded_bottom: component ? [component.id] : [],compact_leading: [],
      compact_trailing: component ? [component.id] : [],minimal: component ? [component.id] : [],
    },
    behavior,
    appearance: { theme: style === "terminal" || style === "shell" ? "dark" : "system",
      roles: { cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state" },
      ...(style === "ring" ? { progressDisplay: "ring" as const } : {}) },
    privacy: "standard",
  });
}

const dashboardActivityUpdateSchema = z.object({
  presentation: liveActivityPresentationSchema,
}).strict();

const dashboardActivityWaitSchema = z.object({
  kind: z.enum(["approval","yes_no"]).default("approval"),
  prompt: z.string().min(1).max(QUESTION_MAX_CHARACTERS),
}).strict();

const dashboardActivityEndSchema = z.object({
  dismissAfterSeconds: z.number().int().min(0).max(14400).default(0),
}).strict();

function galleryInteractionKind(style: (typeof liveActivityStyles)[number]): "approval" | "yes_no" | null {
  if (style === "approval" || style === "shell") return "approval";
  if (style === "verdict" || style === "signal") return "yes_no";
  return null;
}

/** The Dashboard Test Lab: launch, update, ask on, end and inspect owner test runs. */
export function registerTestLabRoutes(app: Hono, shared: WebRouteContext): void {
  const { db,accountAuth,apnsMode,notificationContentCipher,dashboardMutationAccount } = shared;
  app.post("/api/dashboard/live-activities/test", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const input = liveActivityTestSchema.parse(await context.req.json());
    const deviceId = internalId("dev", input.deviceId);
    if (!deviceId) return context.json({ error: "device_not_found" }, 404);
    const effectivePolicy = await loadAccountPresentationPolicy(db,account.principalId);
    let configuration: ReturnType<typeof resolveDashboardActivityConfiguration>;
    try {
      configuration = resolveDashboardActivityConfiguration(input,effectivePolicy,account.principalId);
    } catch (error) {
      if (error instanceof ActivityPrivacyPolicyError) {
        return context.json({ error: error.code },409);
      }
      throw error;
    }
    const result=await executeActivityCommand(db,{kind:"owner",principalId:account.principalId,sourceName:configuration.sourceName},{
      operation:"start",source:"owner",input,deviceId,configuration,apnsMode:apnsMode,
      contentCipher:notificationContentCipher,
      lease:{idleSeconds:dashboardTestIdleTimeoutSeconds,hardSeconds:dashboardTestHardTimeoutSeconds,staleSeconds:dashboardTestStaleAfterSeconds},
    });
    if(result.kind==="start_rejected") return context.json(result.reason,result.category==="missing"?404:409);
    return context.json({...result.receipt,instruction:"Open Relo on this iPhone and tap Refresh to render the preview."},result.created?201:200);
  });

  app.post("/api/dashboard/live-activities/:activityId/update", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const activityId = internalId("act",context.req.param("activityId"));
    if (!activityId) return context.json({ error: "not_found" },404);
    const input = dashboardActivityUpdateSchema.parse(await context.req.json());
    const effectivePolicy = await loadAccountPresentationPolicy(db,account.principalId);
    let stored: ReturnType<typeof persistedPresentationColumns>;
    try {
      const governed = applyActivityPrivacyPolicy(input,effectivePolicy.policy);
      stored = persistedPresentationColumns(governed.presentation);
    } catch (error) {
      if (error instanceof ActivityPrivacyPolicyError) {
        return context.json({ error: error.code },409);
      }
      throw error;
    }
    const result=await executeActivityCommand(db,{kind:"owner",principalId:account.principalId,sourceName:"Relo Test Lab"},{
      operation:"update",activityId,idempotencyKey:undefined,requestHash:taskActivityRequestHash("dashboard-update",input),
      apnsMode:apnsMode,input:{presentation:stored.presentation},policy:effectivePolicy,ownerLease:{idleSeconds:dashboardTestIdleTimeoutSeconds,hardSeconds:dashboardTestHardTimeoutSeconds,staleSeconds:dashboardTestStaleAfterSeconds},
    });
    if(result.kind!=="applied") return context.json({error:result.kind==="not_found"?"activity_not_active":result.kind},409);
    if(!result.projection) throw new Error("owner_activity_projection_missing");
    return context.json({activity:result.activity,...result.projection});
  });

  app.post("/api/dashboard/live-activities/:activityId/reactivate", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const activityId = internalId("act",context.req.param("activityId"));
    if (!activityId) return context.json({ error: "not_found" },404);
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const activity = await client.query<any>(
        `SELECT * FROM live_activities
         WHERE id=$1 AND principal_id=$2 AND state='active' AND expires_at>now()
         FOR UPDATE`,
        [activityId,account.principalId],
      );
      if (!activity.rowCount || !activity.rows[0].target_device_ids?.length) {
        await transaction.rollback();
        return context.json({ error: "activity_not_active" },409);
      }
      const dismissedTargets = await client.query<{ device_id: string }>(
        `SELECT device_id FROM live_activity_presentation_leases
         WHERE principal_id=$1 AND live_activity_id=$2 AND state='not_presented'
           AND device_id=ANY($3::uuid[])
         ORDER BY device_id FOR UPDATE`,
        [account.principalId,activityId,activity.rows[0].target_device_ids],
      );
      if (!dismissedTargets.rowCount) {
        await transaction.rollback();
        return context.json({ error: "activity_already_presented" },409);
      }
      const deviceIds = dismissedTargets.rows.map((row: { device_id: string }) => row.device_id);
      const sourceName = await dashboardActivitySourceName(client,account.principalId,activityId);
      const command = await createDashboardActivityEvent(client,{
        principalId: account.principalId,
        activity: activity.rows[0],
        operation: "update",
        deviceIds,
        sourceName,
        apnsMode: apnsMode,
      });
      if (!command.delivery.durableCommands) {
        await transaction.rollback();
        return context.json({ error: "activity_target_unavailable" },409);
      }
      await recordDashboardActivityOperation(client,{
        principalId: account.principalId,
        activity: activity.rows[0],
        operation: "update",
        delivery: command.delivery,
        request: { reactivate: true,deviceIds: deviceIds.map((id: string) => publicId("dev",id)) },
      });
      await transaction.commit();
      return context.json({
        activity: serializeTaskActivity(activity.rows[0]),
        reactivatedDeviceIds: deviceIds.map((id: string) => publicId("dev",id)),
        ...command,
      });
    } catch (error) {
      await transaction.rollback(); throw error;
    } finally { await transaction.close(); }
  });

  app.post("/api/dashboard/live-activities/:activityId/wait", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const activityId = internalId("act",context.req.param("activityId"));
    if (!activityId) return context.json({ error: "not_found" },404);
    const input = dashboardActivityWaitSchema.parse(await context.req.json());
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const parent = await client.query<any>(
        `SELECT *,expires_at<=clock_timestamp() AS deadline_passed FROM live_activities WHERE id=$1 AND principal_id=$2 AND state='active'
           AND requester_service_id IS NULL AND requester_credential_id IS NULL FOR UPDATE`,
        [activityId,account.principalId],
      );
      if (!parent.rowCount || parent.rows[0].deadline_passed || !parent.rows[0].target_device_ids?.length) {
        await transaction.rollback();
        return context.json({ error: "activity_not_active" },409);
      }
      // The Test Lab asks exactly like an agent: the question folds into this card.
      const sourceName = await dashboardActivitySourceName(client,account.principalId,activityId);
      const folded = await foldQuestionIntoCard(client,{
        principalId: account.principalId,row: parent.rows[0],apnsMode: apnsMode,fallbackSourceName: sourceName,
        question: { type: input.kind,prompt: input.prompt,expiresInSeconds: QUESTION_SECONDS },
      });
      if (folded.kind !== "folded") {
        await transaction.rollback();
        return context.json({ error: folded.kind },409);
      }
      await recordDashboardActivityOperation(client,{
        principalId: account.principalId, activity: folded.activity, operation: "wait",
        delivery: folded.delivery, request: input,
      });
      // One copy of the question per phone; the first is the canonical one the caller waits on.
      const requests = (await client.query<any>(
        `SELECT r.id,r.notification_event_id,r.kind,r.state,r.expires_at FROM interaction_requests r
         JOIN notification_events e ON e.id=r.notification_event_id
         WHERE e.principal_id=$1 AND e.idempotency_key LIKE $2 ORDER BY r.id=$3 DESC,r.created_at,r.id`,
        [account.principalId,`activity:${activityId}:${folded.activity.sequence}:update:%`,folded.interactionRequestId])).rows;
      const interactions = requests.map((request) => ({ id: publicId("int",request.id),
        notificationId: publicId("ntf",request.notification_event_id),kind: request.kind,state: request.state,
        expiresAt: new Date(request.expires_at).toISOString() }));
      await transaction.commit();
      return context.json({
        activity: serializeTaskActivity(folded.activity),
        eventId: interactions[0]!.notificationId,eventIds: interactions.map((interaction) => interaction.notificationId),
        delivery: folded.delivery,queued: folded.delivery.apnsJobs,
        interaction: interactions[0],interactions,
      });
    } catch (error) {
      await transaction.rollback();
      if (error instanceof Error && error.message === "activity_target_unavailable") {
        return context.json({ error: "activity_target_unavailable" },409);
      }
      throw error;
    } finally { await transaction.close(); }
  });

  app.post("/api/dashboard/live-activities/end-all", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const input = dashboardActivityEndSchema.parse(await context.req.json());
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const active = await client.query<any>(
        `SELECT * FROM live_activities
         WHERE principal_id=$1 AND state='active'
           AND requester_service_id IS NULL AND requester_credential_id IS NULL

         ORDER BY created_at,id FOR UPDATE`,
        [account.principalId],
      );
      const ended: Array<{ id: string; sequence: number }> = [];
      const eventIds: string[] = [];
      const delivery = { eligibleDevices: 0, durableCommands: 0, apnsJobs: 0 };
      for (const current of active.rows) {
        const outcome=await executeActivityCommandInTransaction(client,{kind:"owner",principalId:account.principalId,sourceName:"Relo Test Lab"},{
          operation:"end",activityId:current.id,idempotencyKey:undefined,requestHash:taskActivityRequestHash("dashboard-end",input),
          apnsMode:apnsMode,input,allowEmptyTargets:true,
        });
        const result=outcome.result;
        if(result.kind==="untargeted_terminal") continue;
        if(result.kind!=="applied"||!result.projection) {
          await transaction.rollback();
          return context.json({error:result.kind==="not_found"?"activity_not_active":result.kind},409);
        }
        ended.push({id:result.activity.id,sequence:result.activity.sequence});
        eventIds.push(...result.projection.eventIds);
        delivery.eligibleDevices+=result.delivery.eligibleDevices;
        delivery.durableCommands+=result.delivery.durableCommands;
        delivery.apnsJobs+=result.delivery.apnsJobs;
      }
      await transaction.commit();
      return context.json({ ended, eventIds, delivery, alreadyTerminal: ended.length === 0 });
    } catch (error) {
      await transaction.rollback(); throw error;
    } finally { await transaction.close(); }
  });

  app.post("/api/dashboard/live-activities/:activityId/end", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const activityId = internalId("act",context.req.param("activityId"));
    if (!activityId) return context.json({ error: "not_found" },404);
    const input = dashboardActivityEndSchema.parse(await context.req.json());
    const result=await executeActivityCommand(db,{kind:"owner",principalId:account.principalId,sourceName:"Relo Test Lab"},{
      operation:"end",activityId,idempotencyKey:undefined,requestHash:taskActivityRequestHash("dashboard-end",input),
      apnsMode:apnsMode,input,
    });
    if(result.kind!=="applied") return context.json({error:result.kind==="not_found"?"activity_not_active":result.kind},409);
    if(!result.projection) throw new Error("owner_activity_projection_missing");
    return context.json({activity:result.activity,...result.projection});
  });

  app.get("/api/dashboard/live-activities/:activityId/status", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    const activityId = internalId("act",context.req.param("activityId"));
    if (!activityId) return context.json({ error: "not_found" },404);
    const externalActivityId = publicId("act",activityId);
    const activity = await db.query<any>(
      `SELECT a.*,latest.interaction_id,latest.event_id AS interaction_event_id,
         latest.kind AS interaction_kind,latest.prompt AS interaction_prompt,
         latest.state AS interaction_state,latest.response AS interaction_response,
         latest.action AS interaction_action,latest.device_id AS interaction_device_id,
         latest.device_name AS interaction_device_name,latest.expires_at AS interaction_expires_at,
         latest.responded_at AS interaction_responded_at,delivery.event_id AS delivery_event_id,
         delivery.summary AS delivery_summary,delivery.job_state AS delivery_job_state,
         delivery.attempt_count AS delivery_attempt_count,delivery.last_error_code AS delivery_error_code,
         delivery.last_error_message AS delivery_error_message,run_card.shown_at AS card_shown_at
       FROM live_activities a
       ${RUN_CARD_EVIDENCE_SQL}
       LEFT JOIN LATERAL (
         SELECT r.id AS interaction_id,e.id AS event_id,r.kind,r.prompt,r.state,r.response,
           r.expires_at,r.responded_at,i.kind AS action,d.id AS device_id,d.name AS device_name
         FROM interaction_requests r
         JOIN notification_events e ON e.id=r.notification_event_id
         LEFT JOIN interactions i ON i.interaction_request_id=r.id
         LEFT JOIN devices d ON d.id=i.device_id
         WHERE e.principal_id=a.principal_id AND (
           e.payload#>>'{liveActivity,activityId}'=$3 OR e.payload#>>'{workbench,parentActivityId}'=$3)
         ORDER BY r.created_at DESC,i.created_at DESC NULLS LAST LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT e.id AS event_id,e.delivery_summary AS summary,j.state AS job_state,
           j.attempt_count,j.last_error_code,j.last_error_message
         FROM notification_events e LEFT JOIN delivery_jobs j ON j.notification_event_id=e.id
         WHERE e.principal_id=a.principal_id AND (
           e.payload#>>'{liveActivity,activityId}'=$3 OR e.payload#>>'{workbench,parentActivityId}'=$3)
         ORDER BY e.created_at DESC,j.updated_at DESC NULLS LAST LIMIT 1
       ) delivery ON true
       WHERE a.id=$1 AND a.principal_id=$2
         AND a.requester_service_id IS NULL AND a.requester_credential_id IS NULL`,
      [activityId,account.principalId,externalActivityId],
    );
    if (!activity.rowCount) return context.json({ error: "not_found" },404);
    const row = activity.rows[0];
    const targets = await db.query<any>(
      `SELECT id,name,notification_authorization,live_activity_authorization,last_seen_at,revoked_at
       FROM devices WHERE principal_id=$1 AND id=ANY($2::uuid[]) ORDER BY name,id`,
      [account.principalId,row.target_device_ids ?? []],
    );
    const deviceReceipts = await db.query<any>(
      `SELECT e.id AS event_id,t.device_id,d.name AS device_name,received.created_at AS received_at,
         e.payload#>>'{liveActivity,activityId}' AS activity_id,
         e.payload#>>'{liveActivity,operation}' AS operation,
         e.payload#>>'{liveActivity,sequence}' AS sequence
       FROM notification_events e
       JOIN notification_event_targets t ON t.notification_event_id=e.id
       JOIN devices d ON d.id=t.device_id AND d.principal_id=e.principal_id
       LEFT JOIN LATERAL (
         SELECT i.created_at FROM interactions i
         WHERE i.notification_event_id=e.id AND i.device_id=t.device_id AND i.kind='received'
         ORDER BY i.created_at DESC,i.id DESC LIMIT 1
       ) received ON true
       WHERE e.principal_id=$1 AND (
         e.payload#>>'{liveActivity,activityId}'=$2 OR e.payload#>>'{workbench,parentActivityId}'=$2)
       ORDER BY e.created_at DESC,e.id DESC,d.name,d.id LIMIT 100`,
      [account.principalId,externalActivityId],
    );
    const response = row.interaction_response === null || row.interaction_response === undefined
      ? null : row.interaction_response;
    const serializedReceipts = deviceReceipts.rows.map((receipt) => ({
      eventId: publicId("ntf",receipt.event_id),
      device: { id: publicId("dev",receipt.device_id), name: receipt.device_name },
      receivedAt: receipt.received_at ?? null,
      activityId: receipt.activity_id ?? null,
      operation: receipt.operation ?? null,
      sequence: receipt.sequence === null ? null : Number(receipt.sequence),
    }));
    const currentCommandReceipts = serializedReceipts.filter((receipt) =>
      receipt.activityId === externalActivityId && receipt.sequence === Number(row.sequence));
    return context.json({ activity: {
      ...serializeTaskActivity(row),
      targets: targets.rows.map((target) => ({ id: publicId("dev",target.id), name: target.name,
        notificationAuthorization: target.notification_authorization,
        liveActivityAuthorization: target.live_activity_authorization,
        lastSeenAt: target.last_seen_at, revoked: Boolean(target.revoked_at) })),
      interaction: row.interaction_id ? {
        id: publicId("int",row.interaction_id), eventId: publicId("ntf",row.interaction_event_id),
        kind: row.interaction_kind, prompt: row.interaction_prompt, state: row.interaction_state,
        response, action: row.interaction_action ?? null,
        device: row.interaction_device_id ? { id: publicId("dev",row.interaction_device_id), name: row.interaction_device_name } : null,
        expiresAt: row.interaction_expires_at, respondedAt: row.interaction_responded_at,
      } : null,
      delivery: row.delivery_event_id ? {
        eventId: publicId("ntf",row.delivery_event_id), summary: row.delivery_summary,
        state: row.delivery_job_state ?? (Number(row.delivery_summary?.apnsJobs ?? 0) ? "pending" : "durable"),
        attempts: Number(row.delivery_attempt_count ?? 0), errorCode: row.delivery_error_code ?? null,
        errorMessage: row.delivery_error_message ?? null,
      } : null,
      deviceReceipts: serializedReceipts,
      currentCommandReceipts,
      activityKit: cardEvidence(row.card_shown_at),
    }});
  });

}
