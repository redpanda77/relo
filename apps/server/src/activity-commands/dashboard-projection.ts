import { randomUUID } from "node:crypto";
import { QUESTION_SECONDS } from "../question-policy.js";
import type { ApnsMode } from "../activities.js";
import { syncActivityPresentationLease } from "../activity-presentation-leases.js";
import { hashToken } from "../auth.js";
import { publicId } from "../ids.js";
import { persistedPresentationColumns,presentationCommandProjection,presentationFromRow,terminalPresentationFromRow } from "../presentation-runtime.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import { independentSubjectKey,lockSubjectAdmission } from "../relevance/commands.js";
import { relevanceDeliveryGuard } from "../relevance/delivery.js";
import { admitOrdinaryEvent } from "../relevance/ordinary-admission.js";
import { serializeTaskActivity,taskActivityRequestHash } from "./runtime.js";
import type { ActivityRow } from "./types.js";

export async function recordDashboardActivityOperation(
  client: SubjectTransaction,
  input: {
    principalId: string; activity: ActivityRow; operation: "start" | "update" | "wait" | "end";
    delivery: { eligibleDevices: number; durableCommands: number; apnsJobs: number };
    request: unknown; dismissAfterSeconds?: number | null; companionActivityId?: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO live_activity_operations(
       live_activity_id,principal_id,idempotency_key,operation,resulting_sequence,request_hash,
       delivery_summary,dismiss_after_seconds,activity_snapshot,companion_activity_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [input.activity.id,input.principalId,`dashboard:${randomUUID()}:${input.operation}`,input.operation,
      input.activity.sequence,taskActivityRequestHash(`dashboard-${input.operation}`,input.request),
      input.delivery,input.dismissAfterSeconds ?? null,serializeTaskActivity(input.activity),
      input.companionActivityId ?? null],
  );
}

export async function dashboardActivitySourceName(
  client: SubjectTransaction,
  principalId: string,
  activityId: string,
): Promise<string> {
  const source = await client.query(
    `SELECT source FROM notification_events
     WHERE principal_id=$1 AND payload#>>'{liveActivity,activityId}'=$2
     ORDER BY created_at,id LIMIT 1`,
    [principalId,publicId("act",activityId)],
  );
  return source.rows[0]?.source ?? "Relo Test Lab";
}


export async function expireUnstartedDashboardDecision(client: SubjectTransaction, activity: ActivityRow): Promise<void> {
  const stored = persistedPresentationColumns(terminalPresentationFromRow(activity,"Expired","warning"));
  const expired = await client.query(
    `UPDATE live_activities SET state='expired',ended_at=clock_timestamp(),updated_at=clock_timestamp(),
       title=$2,status=$3,detail=$4,progress=$5,symbol=$6,style=$7,privacy=$8,accent_color=$9,
       presentation=$10,presentation_sha256=$11,terminal_reason='interaction_expired',
       terminal_actor='server',terminal_policy='interaction_expiry',terminal_transition_at=clock_timestamp()
     WHERE id=$1 RETURNING *`,
    [activity.id,stored.title,stored.status,stored.detail,stored.progress,stored.symbol,stored.style,
      stored.privacy,stored.accentColor,stored.presentation,stored.presentationHash],
  );
  Object.assign(activity,expired.rows[0]);
}

export async function createDashboardActivityEvent(
  client: SubjectTransaction,
  input: {
    principalId: string; activity: ActivityRow; operation: "start" | "update" | "end";
    deviceIds: string[]; sourceName: string; dismissAfterSeconds?: number;
    interactionKind?: "approval" | "yes_no"; prompt?: string;
    parentActivityId?: string;
    originHash?: string | null;
    apnsMode: ApnsMode;
  },
): Promise<{
  eventId: string | null; eventIds: string[]; queued: number;
  delivery: { eligibleDevices: number; durableCommands: number; apnsJobs: number };
  interaction: Record<string,unknown> | null; interactions: Record<string,unknown>[];
}> {
  const eligible = await client.query(
    `SELECT d.id,d.apns_environment,d.live_activity_authorization,
       d.live_activity_push_to_start_token
     FROM unnest($1::uuid[]) WITH ORDINALITY target(id,position)
     JOIN devices d ON d.id=target.id
     WHERE d.principal_id=$2
       AND ($3::boolean=false OR (
         d.revoked_at IS NULL AND d.live_activity_authorization='authorized'
       )) ORDER BY target.position`,
    [input.deviceIds,input.principalId,Boolean(input.interactionKind)],
  );
  if (!eligible.rows.length || eligible.rows.length !== input.deviceIds.length) return {
    eventId: null, eventIds: [], queued: 0,
    delivery: { eligibleDevices: eligible.rows.length, durableCommands: 0, apnsJobs: 0 },
    interaction: null, interactions: [],
  };
  const activityId = publicId("act",input.activity.id);
  const eventExpiresAt = new Date(Date.now()+(input.operation === "end" ? 60 : 10)*60*1_000);
  const eventIds: string[] = [];
  const interactions: Record<string,unknown>[] = [];
  let apnsJobs = 0;
  if (input.interactionKind) {
    const idempotencyKey = `dashboard:${randomUUID()}:${input.operation}`;
    const actor = { principalId: input.principalId,sourceId: `account:${input.principalId}` };
    await lockSubjectAdmission(client,actor,independentSubjectKey(idempotencyKey));
    const event = await client.query(
      `INSERT INTO notification_events(
         principal_id,source,kind,title,body,payload,idempotency_key,target_mode,expires_at,origin_hash
       ) VALUES ($1,$2,'live_activity',$3,$4,'{}'::jsonb,$5,'explicit',$6,$7) RETURNING id,created_at`,
      [input.principalId,input.sourceName,input.activity.title,input.activity.detail ?? "",
        idempotencyKey,eventExpiresAt,
        input.originHash ?? input.activity.origin_hash ?? null],
    );
    await client.query(
      `INSERT INTO notification_event_targets(notification_event_id,device_id)
       SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
      [event.rows[0]!.id,input.deviceIds],
    );
    const admission = await admitOrdinaryEvent(client,actor,{
      apnsMode: input.apnsMode,kind: "decision",eventId: event.rows[0]!.id,createdAt: event.rows[0]!.created_at,
      idempotencyKey,intentHash: hashToken(JSON.stringify({ activityId,kind: input.interactionKind,prompt: input.prompt })),
      actionDeadlineCap: input.activity.expires_at,
      interaction: { kind: input.interactionKind,prompt: input.prompt ?? input.activity.title,actionSeconds: QUESTION_SECONDS },
    });
    if (admission.kind !== "applied" || !admission.request) throw new Error("dashboard_decision_admission_failed");
    const request = admission.request;
    const expired = request.state === "expired";
    if (expired) await expireUnstartedDashboardDecision(client,input.activity);
    const interaction = {
      id: publicId("int",request.id), notificationId: publicId("ntf",event.rows[0]!.id),
      kind: input.interactionKind, state: request.state, expiresAt: new Date(request.expires_at).toISOString(),
    };
    const firstDevice = eligible.rows[0]!;
    const commonCommand = presentationCommandProjection(presentationFromRow(input.activity));
    const command = {
      operation: expired ? "end" : input.operation, activityId, targetDeviceId: publicId("dev",firstDevice.id),
      generation: Number(input.activity.generation),
      style: input.activity.style ?? "standard", sourceName: input.sourceName,
      expiresAt: input.activity.expires_at ?? null, staleAt: input.activity.stale_at ?? null,
      alertOwner: "app", sequence: Number(input.activity.sequence),
      dismissAfterSeconds: input.dismissAfterSeconds ?? null, interaction: null,
      ...commonCommand,
    };
    await client.query(
      "UPDATE notification_events SET payload=$2::jsonb WHERE id=$1",
      [event.rows[0]!.id,{ liveActivity: command, interactionId: interaction.id,
        interactionType: input.interactionKind,
        ...(input.parentActivityId ? { workbench: { parentActivityId: input.parentActivityId } } : {}) }],
    );
    const remote = input.apnsMode === "disabled" || expired ? { rowCount: 0 } : await client.query(
      `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
       SELECT $1,d.id,'live_activity_start',$3 FROM devices d JOIN notification_events e ON e.id=$1
       WHERE e.state='active' AND ${relevanceDeliveryGuard("e")} AND d.id=ANY($2::uuid[]) AND d.principal_id=$4
         AND d.apns_environment=$5::apns_environment
         AND d.live_activity_push_to_start_token IS NOT NULL ON CONFLICT DO NOTHING`,
      [event.rows[0]!.id,input.deviceIds,input.activity.id,input.principalId,input.apnsMode],
    );
    const eventId = publicId("ntf",event.rows[0]!.id);
    const delivery = { eligibleDevices: eligible.rows.length, durableCommands: eligible.rows.length,
      apnsJobs: remote.rowCount ?? 0 };
    await client.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",[
      event.rows[0]!.id,delivery,
    ]);
    return {
      eventId, eventIds: [eventId], queued: remote.rowCount ?? 0,
      delivery,
      interaction, interactions: [interaction],
    };
  }
  for (const device of eligible.rows) {
    const lease = await syncActivityPresentationLease(client,{
      principalId: input.principalId,
      activity: input.activity,
      deviceId: device.id,
      operation: input.operation,
    });
    const presentationCommand = presentationCommandProjection(presentationFromRow(input.activity));
    const event = await client.query(
      `INSERT INTO notification_events(
         principal_id,source,kind,title,body,payload,idempotency_key,target_mode,expires_at,origin_hash
       ) VALUES ($1,$2,'live_activity',$3,$4,'{}'::jsonb,$5,'explicit',$6,$7) RETURNING id`,
      [input.principalId,input.sourceName,input.activity.title,input.activity.detail ?? "",
        `dashboard:${randomUUID()}:${input.operation}`,eventExpiresAt,
        input.originHash ?? input.activity.origin_hash ?? null],
    );
    await client.query(
      `INSERT INTO notification_event_targets(notification_event_id,device_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [event.rows[0]!.id,device.id],
    );
    const command = {
      operation: input.operation, activityId, targetDeviceId: publicId("dev",device.id),
      generation: Number(input.activity.generation),
      style: input.activity.style ?? "standard", sourceName: input.sourceName,
      expiresAt: input.activity.expires_at ?? null, staleAt: input.activity.stale_at ?? null,
      alertOwner: (input.operation === "start" || lease.restartRequired) && input.apnsMode !== "disabled"
        && device.apns_environment === input.apnsMode && device.live_activity_push_to_start_token
        ? "apns" : input.operation === "start" ? "app" : "none",
      sequence: Number(input.activity.sequence), dismissAfterSeconds: input.dismissAfterSeconds ?? null,
      interaction: null,relevanceScore: lease.relevanceScore,
      presentationState: lease.state,otherActiveCount: lease.otherActiveCount,
      ...presentationCommand,
    };
    await client.query(
      "UPDATE notification_events SET payload=$2::jsonb WHERE id=$1",
      [event.rows[0]!.id,{ liveActivity: command }],
    );
    const remoteEligible = input.apnsMode !== "disabled"
      && device.apns_environment === input.apnsMode
      && device.live_activity_authorization === "authorized"
      && (input.operation !== "start" && !lease.restartRequired
        || Boolean(device.live_activity_push_to_start_token));
    if (remoteEligible) {
      await client.query(
        `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [event.rows[0]!.id,device.id,
          input.operation === "start" || lease.restartRequired ? "live_activity_start" : "live_activity_update",
          input.activity.id],
      );
      apnsJobs += 1;
    }
    await client.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",[
      event.rows[0]!.id,{ eligibleDevices: 1, durableCommands: 1, apnsJobs: remoteEligible ? 1 : 0 },
    ]);
    eventIds.push(publicId("ntf",event.rows[0]!.id));
  }
  return {
    eventId: eventIds[0] ?? null, eventIds, queued: apnsJobs,
    delivery: { eligibleDevices: eligible.rows.length, durableCommands: eventIds.length, apnsJobs },
    interaction: interactions[0] ?? null, interactions,
  };
}


