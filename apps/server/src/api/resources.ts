import { decodeCursor,encodeCursor } from "../cursor.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  
  liveActivityStyles } from "../activities.js";
import { presentationActivityKitContentStateSchema } from "@relo/notification-contracts";

import type { Database } from "../db.js";
import { internalId, publicId } from "../ids.js";

import { createLiveActivityCredential } from "../live-activity-interaction.js";

import { callbackResource } from "../interaction-callbacks.js";

import {
  
  decryptedNotificationBody,
  
  type NotificationContentCipher } from "../notification-content.js";
import { stableJson } from "../stable-json.js";

export const mobileInboxHistoryWindow = 250;

export const inboxHistoryCursorSchema = z.tuple([z.literal("inbox-history-v1"),z.iso.datetime(),z.uuid()]);
export const deviceInventoryCursorSchema = z.tuple([z.literal("devices-v1"),z.iso.datetime(),z.uuid()]);

/** The read watermark: the newest visible event, as an opaque [createdAt, id] cursor. */
export function encodeSyncCursor(createdAt: string, id: string): string {
  return encodeCursor([createdAt,id]);
}

export async function inboxReadMetadata(
  db: Database,
  principalId: string,
  deviceId: string | undefined,
): Promise<{ readWatermark: string | null; unread: { account: number; projects: Record<string, number> } }> {
  const values: unknown[] = [principalId];
  if (deviceId) values.push(deviceId);
  const visibility = deviceId ? `AND (e.target_mode='broadcast' OR EXISTS (
    SELECT 1 FROM notification_event_targets target
    WHERE target.notification_event_id=e.id AND target.device_id=$2
  ))` : "";
  const result = await db.query<any>(
    `WITH visible AS (
       SELECT e.id,e.created_at,e.project_resource_id
       FROM notification_events e
       WHERE e.principal_id=$1 ${visibility}
     ), latest AS (
       SELECT created_at,id FROM visible ORDER BY created_at DESC,id DESC LIMIT 1
     ), unread AS (
       SELECT v.project_resource_id,count(*)::int AS count
       FROM visible v JOIN notification_events e ON e.id=v.id
       WHERE e.read_at IS NULL AND e.withdrawn_at IS NULL
       GROUP BY v.project_resource_id
     )
     SELECT
       (SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM latest) AS latest_at,
       (SELECT id FROM latest) AS latest_id,
       COALESCE((SELECT sum(count)::int FROM unread),0) AS unread_account,
       COALESCE((SELECT jsonb_object_agg(COALESCE('prj_'||project_resource_id::text,'direct'),count)
                 FROM unread),'{}'::jsonb) AS unread_projects`,
    values,
  );
  const row = result.rows[0] ?? {};
  return {
    readWatermark: row.latest_at && row.latest_id ? encodeSyncCursor(row.latest_at, row.latest_id) : null,
    unread: { account: Number(row.unread_account ?? 0), projects: row.unread_projects ?? {} },
  };
}

export function encodeInboxHistoryCursor(createdAt: string, id: string): string {
  return encodeCursor(["inbox-history-v1",createdAt,id]);
}

export function decodeInboxHistoryCursor(value: string | undefined): { createdAt: string; id: string } | undefined {
  const parsed = decodeCursor(value,inboxHistoryCursorSchema);
  return parsed && { createdAt: parsed[1],id: parsed[2] };
}

export function encodeDeviceInventoryCursor(registeredAt: string, id: string): string {
  return encodeCursor(["devices-v1",registeredAt,id]);
}

export function decodeDeviceInventoryCursor(value: string | undefined): { registeredAt: string; id: string } | undefined {
  const parsed = decodeCursor(value,deviceInventoryCursorSchema);
  return parsed && { registeredAt: parsed[1],id: parsed[2] };
}

export async function jsonBody<T>(context: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await context.req.json());
}

export const inboxLiveActivitySchema = z.object({
  operation: z.enum(["start","update","end"]),
  activityId: z.string(),
  generation: z.number().int().positive(),
  targetDeviceId: z.string(),
  style: z.enum(liveActivityStyles),
  sourceName: z.string(),
  expiresAt: z.iso.datetime().nullable().default(null),
  staleAt: z.iso.datetime().nullable().default(null),
  alertOwner: z.enum(["apns","app","none"]).default("none"),
  sequence: z.number().int().min(0).default(0),
  providerTimestamp: z.number().int().min(0).optional(),
  relevanceScore: z.number().min(0).max(1).default(0.5),
  presentationState: z.enum([
    "eligible","foreground","background","pending_token","not_presented","ending","ended","unknown",
  ]).default("unknown"),
  otherActiveCount: z.number().int().min(0).default(0),
  dismissAfterSeconds: z.number().int().min(0).max(14400).nullable().default(null),
  priority: z.union([z.literal(5),z.literal(10)]).default(5),
  interaction: z.object({
    id: z.string(), notificationId: z.string(), kind: z.enum(["approval","yes_no"]),
    state: z.enum(["pending","approved","denied","yes","no","expired","canceled"]),
    credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.iso.datetime(),
  }).strict().nullable().default(null),
  ...presentationActivityKitContentStateSchema.shape,
}).strict();

export function inboxLiveActivity(payload: unknown): z.infer<typeof inboxLiveActivitySchema> | null {
  if (!payload || typeof payload !== "object") return null;
  const stored = (payload as Record<string, unknown>).liveActivity;
  if (!stored || typeof stored !== "object") return null;
  const parsed = inboxLiveActivitySchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export function projectedInboxLiveActivity(
  payload: unknown,
  row: any,
  deviceId: string | undefined,
  credentialVersion: number | undefined,
  secret: string | undefined,
): z.infer<typeof inboxLiveActivitySchema> | null {
  const command = inboxLiveActivity(payload);
  if (!command || !deviceId) return command;
  const projected = {
    ...command,
    targetDeviceId: publicId("dev",deviceId),
    alertOwner: command.operation === "start" && row.delivery_state ? "apns" as const : command.alertOwner,
  };
  if (credentialVersion === undefined || !secret || !row.interaction_id || !row.interaction_expires_at) return projected;
  const expiresAt = new Date(row.interaction_expires_at);
  return { ...projected, interaction: {
    id: publicId("int",row.interaction_id),
    notificationId: publicId("ntf",row.id),
    kind: row.interaction_kind,
    state: row.interaction_state,
    credential: createLiveActivityCredential(secret,{
      interactionId: row.interaction_id,
      notificationEventId: row.id,
      deviceId,
      principalId: row.principal_id,
      credentialVersion,
      expiresAt,
    }),
    expiresAt: expiresAt.toISOString(),
  }};
}

export function inboxPrivacy(payload: unknown): "standard" | "private" {
  if (!payload || typeof payload !== "object") return "standard";
  return (payload as Record<string,unknown>).privacy === "private" ? "private" : "standard";
}

export function selectedDeviceIds(values: unknown): string[] | null {
  if (values === undefined) return null;
  const publicIds = z.array(z.string()).min(1).max(50).parse(values);
  const ids = publicIds.map((value) => internalId("dev",value));
  if (ids.some((value) => !value || !z.uuid().safeParse(value).success)) return [];
  const unique = [...new Set(ids as string[])];
  return unique.length === ids.length ? unique : [];
}

export function mutationRequestHash(operation: string, value: unknown): string {
  return createHash("sha256").update(`relo:${operation}:v1\n${stableJson(value)}`).digest("hex");
}

export const inboxContextSchema = z.object({
  providerName: z.string().trim().min(1).max(80).optional(),
  producerKind: z.enum(["agent","service","webhook","manual"]).optional(),
  computer: z.string().trim().min(1).max(120).optional(),
  project: z.string().trim().min(1).max(120).optional(),
  providerThreadId: z.string().trim().min(1).max(200).optional(),
  providerWorkItemId: z.string().trim().min(1).max(200).optional(),
  threadName: z.string().trim().min(1).max(160).optional(),
  taskTitle: z.string().trim().min(1).max(160).optional(),
  threadNameSource: z.enum(["provider","explicit","fallback"]).optional(),
  taskTitleSource: z.enum(["provider","prompt_summary","explicit","fallback"]).optional(),
}).strict();

export function inboxContext(payload: unknown): z.infer<typeof inboxContextSchema> | null {
  if (!payload || typeof payload !== "object") return null;
  const parsed = inboxContextSchema.safeParse((payload as Record<string,unknown>).context);
  return parsed.success && Object.keys(parsed.data).length ? parsed.data : null;
}

export function inboxActivitySummary(row: any) {
  if (!row.activity_summary_id) return null;
  const state = String(row.activity_summary_state ?? "unknown");
  const staleAt = row.activity_summary_stale_at ?? null;
  const expiresAt = row.activity_summary_expires_at ?? null;
  const terminalReason = state === "replaced"
    ? "superseded"
    : state === "ended"
      ? "ended_by_producer"
      : state === "expired"
        ? row.activity_summary_lifecycle_provider && staleAt && expiresAt
          && new Date(staleAt).getTime() <= new Date(expiresAt).getTime()
          ? "inactivity_timeout"
          : "absolute_expiry"
        : null;
  return {
    id: publicId("act",row.activity_summary_id),
    originThreadId: row.activity_summary_origin_hash ?? null,
    conversationId: row.activity_summary_conversation_id
      ? publicId("cnv",row.activity_summary_conversation_id) : null,
    workItemId: row.activity_summary_work_item_id
      ? publicId("wrk",row.activity_summary_work_item_id) : null,
    generation: Number(row.activity_summary_generation),
    sequence: Number(row.activity_summary_sequence),
    state,
    title: row.activity_summary_title,
    status: row.activity_summary_status,
    detail: row.activity_summary_detail ?? null,
    progress: row.activity_summary_progress == null ? null : Number(row.activity_summary_progress),
    terminalReason,
    context: inboxContext({ context: row.activity_summary_context }),
    createdAt: row.activity_summary_created_at ?? null,
    updatedAt: row.activity_summary_updated_at ?? null,
    staleAt,
    expiresAt,
    endedAt: row.activity_summary_ended_at ?? null,
  };
}

export const inboxActivityProjectionSql = `activity.id AS activity_summary_id,
  activity.origin_hash AS activity_summary_origin_hash,
  activity.conversation_id AS activity_summary_conversation_id,
  activity.work_item_id AS activity_summary_work_item_id,
  activity.generation AS activity_summary_generation,
  activity.sequence AS activity_summary_sequence,
  activity.state::text AS activity_summary_state,
  activity.title AS activity_summary_title,
  activity.status AS activity_summary_status,
  activity.detail AS activity_summary_detail,
  activity.progress AS activity_summary_progress,
  activity.context AS activity_summary_context,
  activity.lifecycle_provider AS activity_summary_lifecycle_provider,
  activity.created_at AS activity_summary_created_at,
  activity.updated_at AS activity_summary_updated_at,
  activity.stale_at AS activity_summary_stale_at,
  activity.expires_at AS activity_summary_expires_at,
  activity.ended_at AS activity_summary_ended_at,
  COALESCE(activity.source_resource_id,e.source_resource_id) AS inbox_source_resource_id,
  source_resource.kind AS inbox_source_kind,
  source_resource.display_name AS inbox_source_name,
  COALESCE(activity.project_resource_id,e.project_resource_id) AS inbox_project_resource_id,
  project_resource.display_name AS inbox_project_name,
  project_resource.is_direct AS inbox_project_is_direct,
  project_resource.palette_ordinal AS inbox_project_palette_ordinal,
  project_resource.icon AS inbox_project_icon,
  project_resource.revision AS inbox_project_revision,
  COALESCE(activity.conversation_id,e.conversation_id) AS inbox_conversation_id,
  COALESCE(activity.work_item_id,e.work_item_id) AS inbox_work_item_id,
  notification_content.summary AS content_summary,
  notification_content.body_ciphertext AS body_ciphertext,
  notification_content.body_format AS body_format,
  notification_content.body_bytes AS body_bytes,
  notification_content.content_sha256 AS content_sha256`;

export const inboxActivityJoinSql = `LEFT JOIN live_activities activity
  ON activity.principal_id=e.principal_id
 AND e.kind='live_activity'
 AND e.payload#>>'{liveActivity,activityId}'=('act_'||activity.id::text)
 LEFT JOIN resource_sources source_resource
   ON source_resource.id=COALESCE(activity.source_resource_id,e.source_resource_id)
 LEFT JOIN resource_projects project_resource
   ON project_resource.id=COALESCE(activity.project_resource_id,e.project_resource_id)
 LEFT JOIN notification_contents notification_content
   ON notification_content.notification_event_id=e.id`;

export function inboxItemResource(
  row: any,
  auth: { deviceId?: string; deviceCredentialVersion?: number },
  credentialDerivationSecret: string | undefined,
  contentCipher?: NotificationContentCipher,
) {
  const deliveryState = (state: string | null): string | null => ({
    pending: "queued", processing: "sending", accepted: "accepted_by_apns",
    retry: "retryable", permanently_failed: "rejected", canceled: "rejected",
    reconciliation_required: "reconciliation_required",
    token_invalid: "token_invalid",
  })[state ?? ""] ?? null;
  const activitySummary = inboxActivitySummary(row);
  const paletteOrdinal = Number(row.inbox_project_palette_ordinal);
  const resources = row.inbox_source_resource_id && row.inbox_project_resource_id
    ? {
        source: {
          id: `src_${row.inbox_source_resource_id}`,
          kind: row.inbox_source_kind,
          name: row.inbox_source_name,
        },
        project: {
          id: `prj_${row.inbox_project_resource_id}`,
          name: row.inbox_project_name,
          isDirect: Boolean(row.inbox_project_is_direct),
          palette: {
            slot: paletteOrdinal % 12,
            generation: Math.floor(paletteOrdinal / 12),
          },
          icon: row.inbox_project_icon,
          revision: Number(row.inbox_project_revision),
        },
        conversationId: row.inbox_conversation_id ? `cnv_${row.inbox_conversation_id}` : null,
        workItemId: row.inbox_work_item_id ? `wrk_${row.inbox_work_item_id}` : null,
      }
    : null;
  const contentBody = row.body_ciphertext && contentCipher
    ? decryptedNotificationBody(contentCipher, row)
    : row.body;
  const content = row.content_summary ? {
    summary: row.content_summary,
    body: contentBody,
    format: row.body_format ?? "text",
    byteLength: Number(row.body_bytes ?? Buffer.byteLength(contentBody ?? "", "utf8")),
  } : null;
  return {
    id: publicId("ntf",row.id), kind: row.kind === "live_activity" ? "live_activity" : "notification",
    sourceName: row.source, sourceImageUrl: row.image_url, title: row.title,
    detail: contentBody || null, content,
    readAt: row.read_at ?? null, withdrawnAt: row.withdrawn_at ?? null,
    result: row.state === "responded" ? "responded" : null,
    deliveryState: deliveryState(row.delivery_state), apnsAcceptedAt: row.accepted_at,
    receivedAt: row.received_at, openedAt: row.opened_at, createdAt: row.created_at_iso,
    destinationUrl: row.deep_link ?? null,
    privacy: inboxPrivacy(row.payload),
    liveActivity: row.kind === "live_activity"
      ? projectedInboxLiveActivity(
        row.payload,row,auth.deviceId,auth.deviceCredentialVersion,credentialDerivationSecret,
      )
      : null,
    activitySummary,
    context: activitySummary?.context ?? inboxContext(row.payload),
    resources,
    interaction: row.interaction_id ? {
      id: publicId("int",row.interaction_id), kind: row.interaction_kind,
      prompt: row.interaction_prompt, state: row.interaction_state,
      expiresAt: row.interaction_expires_at, respondedAt: row.interaction_responded_at,
    } : null,
  };
}

export function interactionResource(row: any) {
  const action = row.response_action === "answer" ? "reply" : (row.response_action ?? null);
  const deviceName = typeof row.response_device_name === "string" ? row.response_device_name.trim() : "";
  return {
    id: publicId("int",row.id),
    eventId: publicId("ntf",row.notification_event_id),
    type: row.kind,
    prompt: row.prompt,
    state: row.state,
    action,
    response: row.response ?? null,
    respondingDevice: row.response_device_id ? {
      id: publicId("dev",row.response_device_id),
      name: deviceName || "Unnamed device",
    } : null,
    expiresAt: new Date(row.expires_at).toISOString(),
    respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    callback: callbackResource(row),
  };
}

export function deviceInventoryResource(row: any) {
  return {
    deviceId: publicId("dev",row.id), name: row.name, installationId: row.installation_id,
    bundleIdentifier: row.bundle_identifier, appVersion: row.app_version, appBuild: row.app_build,
    osVersion: row.os_version, model: row.model, apnsEnvironment: row.apns_environment,
    notificationAuthorization: row.notification_authorization,
    liveActivityAuthorization: row.live_activity_authorization,
    lastSeenAt: row.last_seen_at, registeredAt: row.registered_at,
  };
}

export const interactionResultSelection = `SELECT r.id,r.notification_event_id,r.kind,r.prompt,r.state,r.response,
  r.expires_at,r.responded_at,r.created_at,
  winner.kind AS response_action,winner.device_id AS response_device_id,d.name AS response_device_name,
  cb.state AS callback_state,cb.attempts AS callback_attempts,cb.last_status AS callback_last_status,
  cb.last_error AS callback_last_error,cb.delivered_at AS callback_delivered_at
  FROM interaction_requests r
  LEFT JOIN interaction_callbacks cb ON cb.interaction_request_id=r.id
  JOIN notification_events e ON e.id=r.notification_event_id
  LEFT JOIN LATERAL (
    SELECT i.kind,i.device_id FROM interactions i
    WHERE i.interaction_request_id=r.id ORDER BY i.created_at,i.id LIMIT 1
  ) winner ON true
  LEFT JOIN devices d ON d.id=winner.device_id`;

