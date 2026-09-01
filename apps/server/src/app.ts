import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  cancelPendingActivityInteractions,
  expireDueActivities,
  liveActivityStyles,
  registerActivityRoutes,
  type ApnsMode,
} from "./activities.js";
import { presentationActivityKitContentStateSchema } from "@relo/notification-contracts";
import type { AccountAuth } from "./account-auth.js";
import { authenticate, generateToken, hashToken, requireScope } from "./auth.js";
import { registerIdempotentMachineRevokeRoute, registerMachineAuthRoutes, registerPublicDeviceAuthorizationRoutes } from "./device-authorization.js";
import type { Database } from "./db.js";
import { internalId, publicId } from "./ids.js";
import { registerMobileAccountRoutes } from "./mobile-auth.js";
import { consumeRateLimit } from "./rate-limit.js";
import { createInteractionSchema, heartbeatSchema, interactionSchema, liveActivityUpdateTokenSchema, notificationRequestSchema, registerDeviceSchema } from "./schemas.js";
import {
  activityPresentationScopeKey,
  markActivityPresentationApplied,
} from "./activity-presentation-leases.js";
import { registerServiceApiRoutes, registerWebhookRoutes } from "./services.js";
import { registerWebAuthRoutes } from "./web.js";
import { createLiveActivityCredential, verifyLiveActivityCredential } from "./live-activity-interaction.js";
import { settleInteractiveLiveActivity } from "./interactive-activity-lifecycle.js";
import {
  ApnsPayloadTooLargeError,
  assertOrdinaryDeliveryIntentWithinBudget,
} from "./delivery-serialization.js";
import { createTransportTokenEncryption, type TransportTokenPurpose } from "./token-encryption.js";
import { credentialConversationId } from "./communication.js";
import { registerDeliveryObservabilityRoutes } from "./delivery-observability.js";
import { loadDeliveryEvidence } from "./delivery-evidence.js";
import { canonicalOriginHash } from "./origin-slots.js";
import { registerContextResourceRoutes } from "./context-resources.js";
import { registerDoctorRoutes } from "./runtime-health.js";
import {
  createNotificationContentCipher,
  decryptedNotificationBody,
  persistNotificationContent,
  prepareNotificationContent,
  type NotificationContentCipher,
} from "./notification-content.js";
import {
  canonicalPresentation,
  persistedPresentationColumns,
  presentationCommandProjection,
} from "./presentation-runtime.js";
import { systemPresentationPolicySnapshot } from "./presentation-policy.js";

const mobileInboxSyncWindow = 250;
const mobileInboxHistoryWindow = 250;

const inboxReadMutationSchema = z.object({
  notificationId: z.string().optional(),
  watermark: z.string().optional(),
}).strict().superRefine((value, context) => {
  if ((value.notificationId === undefined) === (value.watermark === undefined)) {
    context.addIssue({ code: "custom", message: "Provide exactly one of notificationId or watermark." });
  }
});

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): [string, string] | undefined {
  if (!value) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded.some((part) => typeof part !== "string")) return undefined;
    return decoded as [string, string];
  } catch {
    return undefined;
  }
}

async function inboxReadMetadata(
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
    readWatermark: row.latest_at && row.latest_id ? encodeCursor(row.latest_at, row.latest_id) : null,
    unread: { account: Number(row.unread_account ?? 0), projects: row.unread_projects ?? {} },
  };
}

type InboxHistoryCursor = { createdAt: string; id: string };
type DeviceInventoryCursor = { registeredAt: string; id: string };

function encodeInboxHistoryCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify(["inbox-history-v1",createdAt,id]),"utf8").toString("base64url");
}

function decodeInboxHistoryCursor(value: string | undefined): InboxHistoryCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value,"base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== "inbox-history-v1") return undefined;
    const parsed = z.tuple([z.literal("inbox-history-v1"),z.iso.datetime(),z.uuid()]).safeParse(decoded);
    return parsed.success ? { createdAt: parsed.data[1], id: parsed.data[2] } : undefined;
  } catch {
    return undefined;
  }
}

function encodeDeviceInventoryCursor(registeredAt: string, id: string): string {
  return Buffer.from(JSON.stringify(["devices-v1",registeredAt,id]),"utf8").toString("base64url");
}

function decodeDeviceInventoryCursor(value: string | undefined): DeviceInventoryCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value,"base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== "devices-v1") return undefined;
    const parsed = z.tuple([z.literal("devices-v1"),z.iso.datetime(),z.uuid()]).safeParse(decoded);
    return parsed.success ? { registeredAt: parsed.data[1], id: parsed.data[2] } : undefined;
  } catch {
    return undefined;
  }
}

async function jsonBody<T>(context: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await context.req.json());
}

const inboxLiveActivitySchema = z.object({
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

function inboxLiveActivity(payload: unknown): z.infer<typeof inboxLiveActivitySchema> | null {
  if (!payload || typeof payload !== "object") return null;
  const stored = (payload as Record<string, unknown>).liveActivity;
  if (!stored || typeof stored !== "object") return null;
  const parsed = inboxLiveActivitySchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

function projectedInboxLiveActivity(
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

function inboxPrivacy(payload: unknown): "standard" | "private" {
  if (!payload || typeof payload !== "object") return "standard";
  return (payload as Record<string,unknown>).privacy === "private" ? "private" : "standard";
}

function selectedDeviceIds(values: unknown): string[] | null {
  if (values === undefined) return null;
  const publicIds = z.array(z.string()).min(1).max(50).parse(values);
  const ids = publicIds.map((value) => internalId("dev",value));
  if (ids.some((value) => !value || !z.uuid().safeParse(value).success)) return [];
  const unique = [...new Set(ids as string[])];
  return unique.length === ids.length ? unique : [];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string,unknown>)
    .sort(([left],[right]) => left.localeCompare(right))
    .map(([key,item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function mutationRequestHash(operation: string, value: unknown): string {
  return createHash("sha256").update(`relo:${operation}:v1\n${stableJson(value)}`).digest("hex");
}

const inboxContextSchema = z.object({
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

function inboxContext(payload: unknown): z.infer<typeof inboxContextSchema> | null {
  if (!payload || typeof payload !== "object") return null;
  const parsed = inboxContextSchema.safeParse((payload as Record<string,unknown>).context);
  return parsed.success && Object.keys(parsed.data).length ? parsed.data : null;
}

function inboxActivitySummary(row: any) {
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

const inboxActivityProjectionSql = `activity.id AS activity_summary_id,
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

const inboxActivityJoinSql = `LEFT JOIN live_activities activity
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

function interactionResource(row: any) {
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
  };
}

function deviceInventoryResource(row: any) {
  return {
    deviceId: publicId("dev",row.id), name: row.name, installationId: row.installation_id,
    bundleIdentifier: row.bundle_identifier, appVersion: row.app_version, appBuild: row.app_build,
    osVersion: row.os_version, model: row.model, apnsEnvironment: row.apns_environment,
    notificationAuthorization: row.notification_authorization,
    liveActivityAuthorization: row.live_activity_authorization,
    lastSeenAt: row.last_seen_at, registeredAt: row.registered_at,
  };
}

const interactionResultSelection = `SELECT r.id,r.notification_event_id,r.kind,r.prompt,r.state,r.response,
  r.expires_at,r.responded_at,r.created_at,
  winner.kind AS response_action,winner.device_id AS response_device_id,d.name AS response_device_name
  FROM interaction_requests r
  JOIN notification_events e ON e.id=r.notification_event_id
  LEFT JOIN LATERAL (
    SELECT i.kind,i.device_id FROM interactions i
    WHERE i.interaction_request_id=r.id ORDER BY i.created_at,i.id LIMIT 1
  ) winner ON true
  LEFT JOIN devices d ON d.id=winner.device_id`;

export type AppDependencies = {
  accountAuth: AccountAuth;
  bootstrapOwnerHandle: string;
  credentialDerivationSecret: string;
  appUrl: string;
  apnsMode: ApnsMode;
};

type AppOptions = AppDependencies | Partial<Pick<AppDependencies,"apnsMode" | "credentialDerivationSecret">>;

export function createApp(
  db: Database,
  dependencies?: AppOptions,
): Hono {
  const app = new Hono();
  const apnsMode = dependencies?.apnsMode ?? "disabled";
  const integratedDependencies = dependencies && "accountAuth" in dependencies ? dependencies : null;
  const tokenEncryption = dependencies?.credentialDerivationSecret
    ? createTransportTokenEncryption(dependencies.credentialDerivationSecret)
    : null;
  const notificationContentCipher = dependencies?.credentialDerivationSecret
    ? createNotificationContentCipher(dependencies.credentialDerivationSecret)
    : apnsMode === "disabled"
      ? createNotificationContentCipher("relo-test-notification-content-secret-v1")
      : null;
  const encryptedTransportToken = (token: string | null, purpose: TransportTokenPurpose): string | null => {
    if (token === null) return null;
    if (!tokenEncryption) throw new Error("Transport token encryption is not configured");
    return tokenEncryption.encrypt(token, purpose);
  };

  registerWebhookRoutes(app, db, apnsMode, notificationContentCipher ?? undefined);

  if (integratedDependencies) {
    registerWebAuthRoutes(app, db, integratedDependencies);
    registerMobileAccountRoutes(app, db, integratedDependencies.accountAuth, integratedDependencies.credentialDerivationSecret);
    registerPublicDeviceAuthorizationRoutes(app, db, integratedDependencies.accountAuth, integratedDependencies.appUrl);
    registerIdempotentMachineRevokeRoute(app, db);
  }

  app.get("/health/live", (context) => context.json({ status: "ok" }));

  const ready = async (context: any) => {
    await db.query("SELECT 1");
    return context.json({ status: "ok" });
  };
  app.get("/health/ready", ready);
  app.get("/health/browser-candidate-attestation", async (context) => {
    if (process.env.RELO_BROWSER_ISOLATED_CANDIDATE_API !== "1" || apnsMode !== "disabled") {
      return context.json({ error: "not_found" },404);
    }
    try {
      const result = await db.query<{ database_name: string }>(
        "SELECT current_database() AS database_name",
      );
      return result.rows[0]?.database_name === "relo_browser"
        ? context.json({ isolatedCandidate: true })
        : context.json({ error: "not_found" },404);
    } catch {
      return context.json({ error: "not_found" },404);
    }
  });

  app.onError((error, context) => {
    if (error instanceof z.ZodError) return context.json({ error: "invalid_request", issues: error.issues }, 400);
    if (error instanceof ApnsPayloadTooLargeError) {
      return context.json({ error: error.code, maximumBytes: 4_096, actualBytes: error.size },400);
    }
    console.error("request failed", { message: error instanceof Error ? error.message : "unknown" });
    return context.json({ error: "internal_error" }, 500);
  });

  app.post("/api/live-activity-responses/:interactionId", async (context) => {
    if (!integratedDependencies) return context.json({ error: "not_found" }, 404);
    const interactionId = internalId("int",context.req.param("interactionId") ?? "");
    const input = z.object({
      notificationId: z.string(), deviceId: z.string(),
      action: z.enum(["approve","deny","yes","no"]),
      credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      idempotencyKey: z.string().trim().min(1).max(200),
    }).strict().parse(await context.req.json());
    const notificationEventId = internalId("ntf",input.notificationId);
    const deviceId = internalId("dev",input.deviceId);
    if (!interactionId || !notificationEventId || !deviceId) return context.json({ error: "not_found" }, 404);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const request = await client.query<any>(
        `SELECT r.id,r.principal_id,r.notification_event_id,r.kind,r.state,r.expires_at,r.responded_at,
           d.credential_version
         FROM interaction_requests r
         JOIN notification_events e ON e.id=r.notification_event_id AND e.principal_id=r.principal_id
         JOIN devices d ON d.id=$3 AND d.principal_id=r.principal_id
         WHERE r.id=$1 AND r.notification_event_id=$2
           AND d.revoked_at IS NULL AND d.live_activity_authorization='authorized'
           AND EXISTS (
             SELECT 1 FROM notification_event_targets t
             WHERE t.notification_event_id=e.id AND t.device_id=d.id
           )
         FOR UPDATE OF r`,
        [interactionId,notificationEventId,deviceId],
      );
      if (!request.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "not_found" }, 404);
      }
      const row = request.rows[0]!;
      const valid = verifyLiveActivityCredential(integratedDependencies.credentialDerivationSecret,input.credential,{
        interactionId,notificationEventId,deviceId,principalId: row.principal_id,
        credentialVersion: Number(row.credential_version),
        expiresAt: new Date(row.expires_at),
      });
      if (!valid) {
        await client.query("ROLLBACK");
        return context.json({ error: "invalid_credential" }, 401);
      }
      const nextState = ({ approve: "approved", deny: "denied", yes: "yes", no: "no" } as const)[input.action];
      const actionMatches = row.kind === "approval"
        ? ["approved","denied"].includes(nextState)
        : ["yes","no"].includes(nextState);
      if (!actionMatches) {
        await client.query("ROLLBACK");
        return context.json({ error: "invalid_action" }, 400);
      }
      const prior = await client.query<any>(
        `SELECT interaction_request_id,notification_event_id,device_id,kind
         FROM interactions WHERE principal_id=$1 AND idempotency_key=$2`,
        [row.principal_id,input.idempotencyKey],
      );
      if (prior.rowCount) {
        const exact = prior.rows[0].interaction_request_id === interactionId
          && prior.rows[0].notification_event_id === notificationEventId
          && prior.rows[0].device_id === deviceId
          && prior.rows[0].kind === input.action;
        await client.query(exact ? "COMMIT" : "ROLLBACK");
        return exact
          ? context.json({ state: row.state, replayed: true, respondedAt: row.responded_at })
          : context.json({ error: "idempotency_conflict" },409);
      }
      if (row.state !== "pending") {
        await client.query("ROLLBACK");
        return context.json({ error: "interaction_terminal", state: row.state },409);
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query("UPDATE interaction_requests SET state='expired',responded_at=now() WHERE id=$1",[interactionId]);
        await client.query("UPDATE notification_events SET state='expired',updated_at=now() WHERE id=$1",[notificationEventId]);
        await settleInteractiveLiveActivity(client,{
          principalId: row.principal_id, notificationEventId, responseState: "expired",
          apnsMode: dependencies?.apnsMode ?? "disabled",
        });
        await client.query("COMMIT");
        return context.json({ error: "interaction_expired" }, 409);
      }
      const inserted = await client.query(
        `INSERT INTO interactions(principal_id,notification_event_id,interaction_request_id,device_id,kind,value,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (principal_id,idempotency_key) DO NOTHING RETURNING id`,
        [row.principal_id,notificationEventId,interactionId,deviceId,input.action,{ action: input.action },input.idempotencyKey],
      );
      if (!inserted.rowCount) {
        const raced = await client.query<any>(
          `SELECT interaction_request_id,notification_event_id,device_id,kind
           FROM interactions WHERE principal_id=$1 AND idempotency_key=$2`,
          [row.principal_id,input.idempotencyKey],
        );
        const exact = raced.rowCount
          && raced.rows[0].interaction_request_id === interactionId
          && raced.rows[0].notification_event_id === notificationEventId
          && raced.rows[0].device_id === deviceId
          && raced.rows[0].kind === input.action;
        await client.query(exact ? "COMMIT" : "ROLLBACK");
        return exact
          ? context.json({ state: row.state, replayed: true, respondedAt: row.responded_at })
          : context.json({ error: "idempotency_conflict" },409);
      }
      const settled = await client.query(
        "UPDATE interaction_requests SET state=$2,response=$3,responded_at=now() WHERE id=$1 AND state='pending' RETURNING responded_at",
        [interactionId,nextState,{ action: input.action }],
      );
      if (!settled.rowCount) throw new Error("interaction settlement lost its request lock");
      await client.query(
        "UPDATE notification_events SET state='responded',updated_at=now() WHERE id=$1",
        [notificationEventId],
      );
      await settleInteractiveLiveActivity(client,{
        principalId: row.principal_id, notificationEventId, responseState: nextState,
        apnsMode: dependencies?.apnsMode ?? "disabled",
      });
      await client.query("COMMIT");
      return context.json({ state: nextState, replayed: false, respondedAt: settled.rows[0].responded_at });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.use("/api/*", authenticate(db));

  app.use("/api/*", async (context,next) => {
    if (!["POST","PUT","PATCH","DELETE"].includes(context.req.method)) return next();
    const path = new URL(context.req.url).pathname;
    if (!/^\/api\/(?:notifications|interactions|live-activities|services)(?:\/|$)/.test(path)) {
      return next();
    }
    const auth = context.get("auth");
    const account = await consumeRateLimit(db,{
      scope: "account", id: auth.principalId, family: "authenticated-mutations", limit: 300,
    });
    if (!account.allowed) {
      context.header("retry-after",String(account.retryAfterSeconds));
      return context.json({ error: "rate_limited", scope: "account", retryAfterSeconds: account.retryAfterSeconds },429);
    }
    const scopedId = auth.credentialId ?? auth.deviceId;
    if (scopedId) {
      const scope = auth.credentialId ? "client" as const : "device" as const;
      const credential = await consumeRateLimit(db,{
        scope, id: scopedId, family: "authenticated-mutations", limit: scope === "client" ? 60 : 120,
      });
      if (!credential.allowed) {
        context.header("retry-after",String(credential.retryAfterSeconds));
        return context.json({ error: "rate_limited", scope, retryAfterSeconds: credential.retryAfterSeconds },429);
      }
    }
    return next();
  });

  registerServiceApiRoutes(app,db,integratedDependencies?.appUrl);
  registerDeliveryObservabilityRoutes(app,db,apnsMode);
  registerContextResourceRoutes(app,db);
  registerDoctorRoutes(app,db,apnsMode);

  registerMachineAuthRoutes(app, db);

  app.get("/api/devices", requireScope("devices:read"), async (context) => {
    const auth = context.get("auth");
    const searchParams = new URL(context.req.url).searchParams;
    const rawLimits = searchParams.getAll("limit");
    const rawCursors = searchParams.getAll("cursor");
    const rawLimit = rawLimits[0];
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (rawLimits.length > 1 || !Number.isInteger(limit) || limit < 1 || limit > 100
      || (rawLimit !== undefined && !/^\d+$/.test(rawLimit))) {
      return context.json({ error: "invalid_limit" },400);
    }
    const rawCursor = rawCursors[0];
    const cursor = decodeDeviceInventoryCursor(rawCursor);
    if (rawCursors.length > 1 || (rawCursor !== undefined && !cursor)) {
      return context.json({ error: "cursor_expired" },410);
    }
    const result = await db.query<any>(
      `WITH scoped AS MATERIALIZED (
         SELECT id,name,installation_id,bundle_identifier,app_version,app_build,
           os_version,model,apns_environment,notification_authorization,
           live_activity_authorization,last_seen_at,registered_at,
           to_char(registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS registered_at_cursor
         FROM devices WHERE principal_id=$1 AND revoked_at IS NULL
       ), metadata AS (
         SELECT ($2::timestamptz IS NULL OR EXISTS (
           SELECT 1 FROM scoped anchor
           WHERE (anchor.registered_at,anchor.id)=($2::timestamptz,$3::uuid)
         )) AS cursor_valid
       ), page AS (
         SELECT scoped.* FROM scoped,metadata
         WHERE metadata.cursor_valid
           AND ($2::timestamptz IS NULL OR (scoped.registered_at,scoped.id)<($2::timestamptz,$3::uuid))
         ORDER BY scoped.registered_at DESC,scoped.id DESC
         LIMIT ${limit + 1}
       )
       SELECT page.*,metadata.cursor_valid
       FROM metadata LEFT JOIN page ON metadata.cursor_valid
       ORDER BY page.registered_at DESC,page.id DESC`,
      [auth.principalId,cursor?.registeredAt ?? null,cursor?.id ?? null],
    );
    const metadata = result.rows[0] as { id: string | null; cursor_valid: boolean } | undefined;
    if (!metadata?.cursor_valid) return context.json({ error: "cursor_expired" },410);
    const pageRows = result.rows.filter((row: any) => row.id !== null);
    const hasMore = pageRows.length > limit;
    const rows = pageRows.slice(0,limit);
    const last = rows.at(-1);
    return context.json({
      devices: rows.map(deviceInventoryResource),
      cursor: hasMore && last ? encodeDeviceInventoryCursor(last.registered_at_cursor,last.id) : null,
      hasMore,
    });
  });

  app.get("/api/devices/self", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    if (!auth.deviceId) return context.json({ error: "device_credential_required" }, 403);
    const result = await db.query<any>(
      `SELECT d.id,d.installation_id,d.credential_version,d.revoked_at,
              p.id AS principal_id,u.name,u.email,u.image
       FROM devices d
       JOIN owner_principals p ON p.id=d.principal_id
       JOIN account_identities i ON i.principal_id=p.id AND i.provider='better-auth'
       JOIN auth.users u ON u.id=i.subject
       WHERE d.id=$1 AND d.principal_id=$2`,
      [auth.deviceId,auth.principalId],
    );
    if (!result.rowCount) return context.json({ error: "not_found" }, 404);
    const row = result.rows[0];
    return context.json({
      account: { accountId: publicId("acc",row.principal_id), name: row.name, email: row.email, imageUrl: row.image ?? null },
      device: {
        deviceId: publicId("dev",row.id), installationId: row.installation_id,
        registrationState: row.revoked_at ? "revoked" : "active",
        credentialVersion: row.credential_version,
      },
    });
  });

  app.put("/api/devices/:deviceId", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    const requested = internalId("dev", context.req.param("deviceId") ?? "");
    if (!requested || requested !== auth.deviceId) return context.json({ error: "forbidden" }, 403);
    const input = heartbeatSchema.parse(await context.req.json());
    const fields: string[] = ["last_seen_at=now()"];
    const values: unknown[] = [];
    const mapping: Record<string, string> = {
      appVersion: "app_version", appBuild: "app_build", osVersion: "os_version", model: "model",
      apnsEnvironment: "apns_environment", apnsToken: "apns_token",
      notificationAuthorization: "notification_authorization",
      liveActivityAuthorization: "live_activity_authorization",
      liveActivityPushToStartToken: "live_activity_push_to_start_token",
    };
    for (const [key, column] of Object.entries(mapping)) {
      let value = (input as Record<string, unknown>)[key];
      if (key === "apnsToken" && typeof value === "string") {
        value = encryptedTransportToken(value,"device.apns_token");
      } else if (key === "liveActivityPushToStartToken" && typeof value === "string") {
        value = encryptedTransportToken(value,"device.live_activity_push_to_start_token");
      }
      if (value !== undefined) { values.push(value); fields.push(`${column}=$${values.length}`); }
    }
    values.push(auth.deviceId, auth.principalId);
    await db.query(`UPDATE devices SET ${fields.join(",")} WHERE id=$${values.length - 1} AND principal_id=$${values.length}`, values);
    return context.json({ status: "ok" });
  });

  app.put("/api/devices/self/live-activities/:activityId/token", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    if (!auth.deviceId) return context.json({ error: "device_credential_required" },403);
    const activityId = internalId("act",context.req.param("activityId") ?? "");
    if (!activityId) return context.json({ error: "not_found" },404);
    const input = liveActivityUpdateTokenSchema.parse(await context.req.json());
    const result = await db.query<{ id: string; generation: number }>(
      `INSERT INTO live_activity_update_tokens(
         live_activity_id,device_id,generation,native_activity_id,token,environment,updated_at
       )
       SELECT a.id,$2,a.generation,$3,$4,$5,now() FROM live_activities a
       WHERE a.id=$1 AND a.principal_id=$6
         AND a.generation=$7
         AND a.state='active' AND a.expires_at>now()
         AND ($2=ANY(a.target_device_ids) OR a.target_device_ids IS NULL)
         AND EXISTS (
           SELECT 1 FROM devices d WHERE d.id=$2 AND d.principal_id=$6
             AND d.revoked_at IS NULL AND d.apns_environment=$5
         )
       ON CONFLICT (live_activity_id,device_id) DO UPDATE SET
         generation=EXCLUDED.generation,native_activity_id=EXCLUDED.native_activity_id,token=EXCLUDED.token,
         environment=EXCLUDED.environment,updated_at=now()
       WHERE live_activity_update_tokens.generation=EXCLUDED.generation
       RETURNING live_activity_id AS id,generation`,
      [activityId,auth.deviceId,input.nativeActivityId,
        encryptedTransportToken(input.token.toLowerCase(),"live_activity_update_token.token"),
        input.environment,auth.principalId,input.generation],
    );
    if (result.rowCount) {
      return context.json({
        activityId: publicId("act",activityId),
        generation: result.rows[0]!.generation,
        status: "registered",
      });
    }
    const current = await db.query<{ generation: number }>(
      "SELECT generation FROM live_activities WHERE id=$1 AND principal_id=$2",
      [activityId,auth.principalId],
    );
    if (current.rowCount && current.rows[0]!.generation !== input.generation) {
      return context.json({
        error: "activity_generation_mismatch",
        code: "ACTIVITY_GENERATION_MISMATCH",
        generation: current.rows[0]!.generation,
      },409);
    }
    return context.json({ error: "not_found" },404);
  });

  app.post("/api/devices/self/live-activities/:activityId/dismissed", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    if (!auth.deviceId) return context.json({ error: "device_credential_required" },403);
    const activityId = internalId("act",context.req.param("activityId") ?? "");
    if (!activityId) return context.json({ error: "not_found" },404);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const activity = await client.query<any>(
        `SELECT * FROM live_activities
         WHERE id=$1 AND principal_id=$2 AND ($3=ANY(target_device_ids) OR target_device_ids IS NULL)
         FOR UPDATE`,
        [activityId,auth.principalId,auth.deviceId],
      );
      if (!activity.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "not_found" },404);
      }
      const active = activity.rows[0]?.state === "active";
      const dismissed = active ? await client.query(
        `INSERT INTO live_activity_presentation_leases(
           live_activity_id,principal_id,device_id,scope_key,state,reason,relevance_score,
           last_command_sequence,selected_at,ended_at,updated_at
         ) VALUES ($1,$2,$3,$4,'not_presented','device_dismissed',0,$5,NULL,NULL,now())
         ON CONFLICT (live_activity_id,device_id) DO UPDATE SET
           state='not_presented',reason='device_dismissed',relevance_score=0,
           last_command_sequence=GREATEST(
             live_activity_presentation_leases.last_command_sequence,EXCLUDED.last_command_sequence
           ),selected_at=NULL,ended_at=NULL,updated_at=now()
         WHERE live_activity_presentation_leases.state<>'not_presented'
         RETURNING live_activity_id`,
        [activityId,auth.principalId,auth.deviceId,
          activityPresentationScopeKey(activity.rows[0]),Number(activity.rows[0].sequence)],
      ) : { rowCount: 0 };
      const changed = Boolean(dismissed.rowCount);
      await client.query(
        "DELETE FROM live_activity_update_tokens WHERE live_activity_id=$1 AND device_id=$2",
        [activityId,auth.deviceId],
      );
      await client.query("COMMIT");
      return context.json({ activityId: publicId("act",activityId),status: "dismissed",changed });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/api/devices/:deviceId", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    const requested = internalId("dev", context.req.param("deviceId") ?? "");
    if (!requested || requested !== auth.deviceId) return context.json({ error: "forbidden" }, 403);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE device_credentials SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL", [auth.deviceId]);
      await client.query(
        `UPDATE devices SET revoked_at=now(),apns_token=NULL,live_activity_push_to_start_token=NULL,
           credential_version=credential_version+1 WHERE id=$1 AND principal_id=$2`,
        [auth.deviceId,auth.principalId],
      );
      await client.query("UPDATE delivery_jobs SET state='canceled',updated_at=now() WHERE device_id=$1 AND state IN ('pending','retry')", [auth.deviceId]);
      await client.query("COMMIT");
      return context.body(null, 204);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  });

  app.post("/api/notifications", requireScope("notifications:send"), async (context) => {
    const input = notificationRequestSchema.parse(await context.req.json());
    if (!notificationContentCipher) return context.json({ error: "content_encryption_unavailable" },503);
    const content = prepareNotificationContent(input);
    const suppliedKey = context.req.header("idempotency-key");
    const idempotencyKey = suppliedKey === undefined
      ? `server:${randomUUID()}`
      : z.string().trim().min(1).max(200).parse(suppliedKey);
    const requestedDeviceIds = selectedDeviceIds(input.deviceIds);
    if (input.deviceIds !== undefined && !requestedDeviceIds?.length) return context.json({ error: "invalid_device_selection" },400);
    const requestHash = mutationRequestHash("notification",{
      input, deviceIds: requestedDeviceIds ? [...requestedDeviceIds].sort() : null,
    });
    const auth = context.get("auth");
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const originHash = input.origin ? canonicalOriginHash(auth.principalId,input.origin) : null;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const eligible = await client.query<{ id: string; apns_token: string | null }>(
        `SELECT id,apns_token FROM devices
         WHERE principal_id=$1 AND revoked_at IS NULL
           AND notification_authorization IN ('authorized','provisional')
           AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[])) ORDER BY id`,
        [auth.principalId,requestedDeviceIds],
      );
      const eligibleDevices = eligible.rows.length;
      if (requestedDeviceIds) {
        if (eligibleDevices !== requestedDeviceIds.length) {
          await client.query("ROLLBACK");
          return context.json({ error: "invalid_device_selection" },400);
        }
      }
      const inserted = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO notification_events(
           principal_id,requester_credential_id,source,kind,title,body,image_url,deep_link,payload,idempotency_key,
           expires_at,request_hash,target_mode,origin_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT DO NOTHING RETURNING id,created_at`,
        [auth.principalId,auth.credentialId,input.sourceName,"notification",input.title,content.preview,input.imageUrl ?? null,
          input.destinationUrl ?? null,input.context ? { context: input.context } : {},
          idempotencyKey,null,requestHash,requestedDeviceIds ? "explicit" : "broadcast",originHash],
      );
      if (!inserted.rowCount) {
        const existing = await client.query<{ id: string; created_at: string; request_hash: string | null; delivery_summary: any }>(
          `SELECT id,created_at,request_hash,delivery_summary FROM notification_events
           WHERE principal_id=$1 AND requester_credential_id=$2 AND idempotency_key=$3`,
          [auth.principalId,auth.credentialId,idempotencyKey],
        );
        if (!existing.rowCount || existing.rows[0]!.request_hash !== requestHash) {
          await client.query("ROLLBACK");
          return context.json({ error: "idempotency_conflict" },409);
        }
        await client.query("COMMIT");
        const delivery = existing.rows[0]!.delivery_summary ?? { eligibleDevices, durableCommands: 1, apnsJobs: 0 };
        return context.json({ eventId: publicId("ntf", existing.rows[0]!.id), createdAt: existing.rows[0]!.created_at,
          delivery, queued: delivery.apnsJobs, replayed: true });
      }
      await persistNotificationContent(client,notificationContentCipher,inserted.rows[0]!.id,content);
      assertOrdinaryDeliveryIntentWithinBudget({
        title: input.title, body: content.preview,
        sourceName: input.sourceName,
        conversationId: originHash ?? credentialConversationId(auth.credentialId,input.title),
        imageUrl: input.imageUrl ?? null, deepLink: input.destinationUrl ?? null,
        notificationId: publicId("ntf",inserted.rows[0]!.id),
        payload: input.context ? { context: input.context } : {},
      });
      if (requestedDeviceIds) {
        await client.query(
          `INSERT INTO notification_event_targets(notification_event_id,device_id)
           SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
          [inserted.rows[0]!.id,requestedDeviceIds],
        );
      }
      const jobs = await client.query(
        `INSERT INTO delivery_jobs(notification_event_id,device_id)
         SELECT $1,d.id FROM devices d
         WHERE d.principal_id=$2 AND d.revoked_at IS NULL AND d.apns_token IS NOT NULL
           AND d.notification_authorization IN ('authorized','provisional')
           AND ($3::uuid[] IS NULL OR d.id=ANY($3::uuid[]))
         ON CONFLICT DO NOTHING`,
        [inserted.rows[0]!.id,auth.principalId,requestedDeviceIds],
      );
      const apnsJobs = jobs.rowCount ?? 0;
      const delivery = { eligibleDevices, durableCommands: 1, apnsJobs };
      await client.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",[inserted.rows[0]!.id,delivery]);
      await client.query("COMMIT");
      return context.json({ eventId: publicId("ntf", inserted.rows[0]!.id), createdAt: inserted.rows[0]!.created_at,
        delivery, queued: apnsJobs, replayed: false }, 201);
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally { client.release(); }
  });

  app.post("/api/interactions", requireScope("interactions:create"), async (context) => {
    const input = createInteractionSchema.parse(await context.req.json());
    const suppliedKey = context.req.header("idempotency-key");
    const idempotencyKey = suppliedKey === undefined
      ? `server:${randomUUID()}`
      : z.string().trim().min(1).max(200).parse(suppliedKey);
    const requestedDeviceIds = selectedDeviceIds(input.deviceIds);
    if (input.deviceIds !== undefined && !requestedDeviceIds?.length) return context.json({ error: "invalid_device_selection" },400);
    const requestHash = mutationRequestHash("interaction",{
      input, deviceIds: requestedDeviceIds ? [...requestedDeviceIds].sort() : null,
    });
    const auth = context.get("auth");
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    if (input.presentation === "live_activity") {
      const primaryLabel = input.primaryLabel ?? (input.type === "approval" ? "Approve" : "Yes");
      const secondaryLabel = input.secondaryLabel ?? (input.type === "approval" ? "Deny" : "No");
      const interactivePresentation = canonicalPresentation({
        content: {
          header: input.title,title: input.title,subtitle: input.prompt,status: "Waiting for input",
        },
        identity: { project: null,thread: null,direct: true },
        state: { kind: "needs_action",tone: "attention",icon: "needs_action" },
        components: [],surfaces: {},
        behavior: input.type === "approval"
          ? { type: "approval",primary: { action: "approve",label: primaryLabel },
              secondary: { action: "deny",label: secondaryLabel } }
          : { type: "yes_no",primary: { action: "yes",label: primaryLabel },
              secondary: { action: "no",label: secondaryLabel } },
        appearance: { theme: "system",roles: {
          cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state",
        } },
        privacy: "standard",
      });
      const interactiveStored = persistedPresentationColumns(interactivePresentation);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const eligible = await client.query<any>(
          `SELECT id,apns_environment,live_activity_push_to_start_token
           FROM devices WHERE principal_id=$1 AND revoked_at IS NULL
             AND live_activity_authorization='authorized'
             AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[]))
           ORDER BY last_seen_at DESC,id LIMIT 50`,
          [auth.principalId,requestedDeviceIds],
        );
        if (!eligible.rowCount || (requestedDeviceIds && eligible.rowCount !== requestedDeviceIds.length)) {
          await client.query("ROLLBACK");
          return context.json({ error: requestedDeviceIds ? "invalid_device_selection" : "no_eligible_device" },400);
        }
        const device = eligible.rows[0]!;
        const eligibleDeviceIds = eligible.rows.map((row: any) => row.id);
        const event = await client.query<{ id: string; created_at: string }>(
          `INSERT INTO notification_events(
             principal_id,requester_credential_id,source,kind,title,body,payload,idempotency_key,expires_at,
             request_hash,target_mode
           ) VALUES ($1,$2,$3,'live_activity',$4,$5,'{}'::jsonb,$6,now()+($7*interval '1 second'),$8,'explicit')
           ON CONFLICT DO NOTHING RETURNING id,created_at`,
          [auth.principalId,auth.credentialId,input.title,input.title,input.prompt,idempotencyKey,
            input.expiresInSeconds,requestHash],
        );
        if (!event.rowCount) {
          const existing = await client.query<any>(
            `SELECT r.id,r.state,e.id AS event_id,e.request_hash,e.delivery_summary,
               e.payload#>>'{liveActivity,activityId}' AS activity_id
             FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
             WHERE e.principal_id=$1 AND e.requester_credential_id=$2 AND e.idempotency_key=$3`,
            [auth.principalId,auth.credentialId,idempotencyKey],
          );
          if (!existing.rowCount || existing.rows[0].request_hash !== requestHash
            || !existing.rows[0].activity_id) {
            await client.query("ROLLBACK");
            return context.json({ error: "idempotency_conflict" },409);
          }
          await client.query("COMMIT");
          const delivery = existing.rows[0].delivery_summary
            ?? { eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 };
          return context.json({
            interaction: { id: publicId("int",existing.rows[0].id), state: existing.rows[0].state },
            eventId: publicId("ntf",existing.rows[0].event_id),
            liveActivityId: existing.rows[0].activity_id,
            delivery, queued: delivery.apnsJobs, replayed: true,
          });
        }
        const style = input.style ?? "approval";
        const activity = await client.query<any>(
          `INSERT INTO live_activities(
             principal_id,requester_credential_id,activity_key,title,status,detail,progress,symbol,style,
             privacy,accent_color,target_device_ids,start_idempotency_key,expires_at,stale_at,
             presentation,presentation_sha256,presentation_policy,presentation_policy_source,
             presentation_preset_id,presentation_preset_revision
           ) VALUES ($1,$2,NULL,$3,'Waiting for input',$4,NULL,'terminal',$5,'standard','#5ED8B7',
             $6::uuid[],$7,now()+($8*interval '1 second'),now()+($8*interval '1 second'),$9::jsonb,$10,
             $11::jsonb,'system',$12,1) RETURNING *`,
          [auth.principalId,auth.credentialId,input.title,input.prompt,style,eligibleDeviceIds,
            `interaction:${idempotencyKey}`,input.expiresInSeconds,
            interactiveStored.presentation,interactiveStored.presentationHash,
            systemPresentationPolicySnapshot(`system.interactive.${style}`),`system.interactive.${style}`],
        );
        const request = await client.query<any>(
          `INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
           VALUES ($1,$2,$3,$4,$5,now()+($6*interval '1 second')) RETURNING id,expires_at`,
          [auth.principalId,event.rows[0]!.id,input.type,input.prompt,hashToken(generateToken()),input.expiresInSeconds],
        );
        await client.query(
          `INSERT INTO notification_event_targets(notification_event_id,device_id)
           SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
          [event.rows[0]!.id,eligibleDeviceIds],
        );
        const liveActivityId = publicId("act",activity.rows[0].id);
        const command = {
          operation: "start", activityId: liveActivityId, targetDeviceId: publicId("dev",device.id),
          generation: Number(activity.rows[0].generation),
          ...presentationCommandProjection(interactivePresentation),
          style, sourceName: input.title, privacy: "standard",
          expiresAt: new Date(activity.rows[0].expires_at).toISOString(),
          staleAt: new Date(activity.rows[0].stale_at).toISOString(),
          alertOwner: "app",
          sequence: 0, dismissAfterSeconds: null, interaction: null,
        };
        await client.query(
          "UPDATE notification_events SET payload=$2::jsonb WHERE id=$1",
          [event.rows[0]!.id,{ liveActivity: command, interactionId: publicId("int",request.rows[0].id),
            interactionType: input.type }],
        );
        const remote = dependencies?.apnsMode === "disabled" ? { rowCount: 0 } : await client.query(
          `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
           SELECT $1,d.id,'live_activity_start',$3 FROM devices d
           WHERE d.id=ANY($2::uuid[]) AND d.principal_id=$4
             AND d.apns_environment=$5::apns_environment
             AND d.live_activity_push_to_start_token IS NOT NULL
           ON CONFLICT DO NOTHING`,
          [event.rows[0]!.id,eligibleDeviceIds,activity.rows[0].id,auth.principalId,dependencies?.apnsMode],
        );
        const delivery = { eligibleDevices: eligible.rows.length, durableCommands: eligible.rows.length,
          apnsJobs: remote.rowCount ?? 0 };
        await client.query(
          "UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",
          [event.rows[0]!.id,delivery],
        );
        await client.query("COMMIT");
        return context.json({
          interaction: { id: publicId("int",request.rows[0].id), state: "pending" },
          eventId: publicId("ntf",event.rows[0]!.id), liveActivityId,
          delivery, queued: delivery.apnsJobs, replayed: false,
        },201);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const eligible = await client.query<{ id: string; apns_token: string | null }>(
        `SELECT id,apns_token FROM devices
         WHERE principal_id=$1 AND revoked_at IS NULL
           AND notification_authorization IN ('authorized','provisional')
           AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[])) ORDER BY id`,
        [auth.principalId,requestedDeviceIds],
      );
      const eligibleDevices = eligible.rows.length;
      if (requestedDeviceIds) {
        if (eligibleDevices !== requestedDeviceIds.length) {
          await client.query("ROLLBACK");
          return context.json({ error: "invalid_device_selection" },400);
        }
      }
      const event = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO notification_events(
           principal_id,requester_credential_id,source,kind,title,body,image_url,deep_link,payload,idempotency_key,expires_at,
           request_hash,target_mode
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+($11*interval '1 second'),$12,$13)
         ON CONFLICT DO NOTHING RETURNING id,created_at`,
        [auth.principalId,auth.credentialId,input.title,input.type === "approval" ? "approval" : "question",input.title,input.prompt,
          input.imageUrl ?? null,input.destinationUrl ?? null,{ interactionType: input.type },idempotencyKey,input.expiresInSeconds,requestHash,
          requestedDeviceIds ? "explicit" : "broadcast"],
      );
      if (!event.rowCount) {
        const existing = await client.query<{ id: string; event_id: string; state: string; request_hash: string | null; delivery_summary: any }>(
          `SELECT r.id,e.id AS event_id,r.state,e.request_hash,e.delivery_summary FROM interaction_requests r
           JOIN notification_events e ON e.id=r.notification_event_id
           WHERE e.principal_id=$1 AND e.requester_credential_id=$2 AND e.idempotency_key=$3`,
          [auth.principalId,auth.credentialId,idempotencyKey],
        );
        if (!existing.rowCount || existing.rows[0]!.request_hash !== requestHash) {
          await client.query("ROLLBACK");
          return context.json({ error: "idempotency_conflict" },409);
        }
        await client.query("COMMIT");
        const delivery = existing.rows[0]!.delivery_summary ?? { eligibleDevices, durableCommands: 1, apnsJobs: 0 };
        return context.json({ interaction: { id: publicId("int",existing.rows[0]!.id), state: existing.rows[0]!.state },
          eventId: publicId("ntf",existing.rows[0]!.event_id),
          delivery, queued: delivery.apnsJobs, replayed: true });
      }
      const request = await client.query<{ id: string }>(
        `INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
         VALUES ($1,$2,$3,$4,$5,now()+($6*interval '1 second')) RETURNING id`,
        [auth.principalId,event.rows[0]!.id,input.type,input.prompt,hashToken(generateToken()),input.expiresInSeconds],
      );
      if (requestedDeviceIds) {
        await client.query(
          `INSERT INTO notification_event_targets(notification_event_id,device_id)
           SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
          [event.rows[0]!.id,requestedDeviceIds],
        );
      }
      await client.query("UPDATE notification_events SET payload=payload||$2::jsonb WHERE id=$1", [event.rows[0]!.id,{ interactionId: publicId("int",request.rows[0]!.id) }]);
      assertOrdinaryDeliveryIntentWithinBudget({
        title: input.title, body: input.prompt,
        sourceName: input.title, conversationId: publicId("int",request.rows[0]!.id),
        imageUrl: input.imageUrl ?? null, deepLink: input.destinationUrl ?? null,
        notificationId: publicId("ntf",event.rows[0]!.id), interactionKind: input.type,
        payload: { interactionType: input.type, interactionId: publicId("int",request.rows[0]!.id) },
      });
      const jobs = await client.query(
        `INSERT INTO delivery_jobs(notification_event_id,device_id)
         SELECT $1,d.id FROM devices d WHERE d.principal_id=$2 AND d.revoked_at IS NULL
           AND d.apns_token IS NOT NULL AND d.notification_authorization IN ('authorized','provisional')
           AND ($3::uuid[] IS NULL OR d.id=ANY($3::uuid[])) ON CONFLICT DO NOTHING`,
        [event.rows[0]!.id,auth.principalId,requestedDeviceIds],
      );
      const apnsJobs = jobs.rowCount ?? 0;
      const delivery = { eligibleDevices, durableCommands: 1, apnsJobs };
      await client.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",[event.rows[0]!.id,delivery]);
      await client.query("COMMIT");
      return context.json({ interaction: { id: publicId("int",request.rows[0]!.id), state: "pending" },
        eventId: publicId("ntf",event.rows[0]!.id),
        delivery, queued: apnsJobs, replayed: false }, 201);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  });

  app.get("/api/interactions/:interactionId", requireScope("interactions:read"), async (context) => {
    const auth = context.get("auth");
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const interactionId = internalId("int",context.req.param("interactionId") ?? "");
    if (!interactionId) return context.json({ error: "not_found" },404);
    const select = `${interactionResultSelection}
       WHERE r.id=$1 AND r.principal_id=$2 AND e.requester_credential_id=$3`;
    let result = await db.query<any>(select,[interactionId,auth.principalId,auth.credentialId]);
    if (!result.rowCount) return context.json({ error: "not_found" },404);
    if (result.rows[0].state === "pending"
      && new Date(result.rows[0].expires_at).getTime() <= Date.now()) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const expired = await client.query<{ notification_event_id: string }>(
          `UPDATE interaction_requests SET state='expired',responded_at=now()
           WHERE id=$1 AND principal_id=$2 AND state='pending'
             AND EXISTS (
               SELECT 1 FROM notification_events owned
               WHERE owned.id=interaction_requests.notification_event_id
                 AND owned.requester_credential_id=$3
             ) RETURNING notification_event_id`,
          [interactionId,auth.principalId,auth.credentialId],
        );
        if (expired.rowCount) {
          await client.query(
            "UPDATE notification_events SET state='expired',updated_at=now() WHERE id=$1",
            [expired.rows[0]!.notification_event_id],
          );
          await settleInteractiveLiveActivity(client,{
            principalId: auth.principalId, notificationEventId: expired.rows[0]!.notification_event_id,
            responseState: "expired", apnsMode: dependencies?.apnsMode ?? "disabled",
          });
        }
        result = await client.query<any>(select,[interactionId,auth.principalId,auth.credentialId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }
    return context.json({ interaction: interactionResource(result.rows[0]) });
  });

  const cancelInteraction = async (context: any) => {
    const auth = context.get("auth");
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const interactionId = internalId("int",context.req.param("interactionId") ?? "");
    if (!interactionId) return context.json({ error: "not_found" },404);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<any>(
        `${interactionResultSelection}
         WHERE r.id=$1 AND r.principal_id=$2 AND e.requester_credential_id=$3 FOR UPDATE OF r`,
        [interactionId,auth.principalId,auth.credentialId],
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "not_found" },404);
      }
      let row = result.rows[0]!;
      if (row.state !== "pending" && row.state !== "canceled") {
        await client.query("ROLLBACK");
        return context.json({ error: "interaction_not_pending", state: row.state },409);
      }
      if (row.state === "pending") {
        await client.query(
          `UPDATE interaction_requests SET state='canceled',responded_at=now()
           WHERE id=$1`,
          [interactionId],
        );
        await client.query(
          "UPDATE notification_events SET state='canceled',updated_at=now() WHERE id=$1",
          [row.notification_event_id],
        );
        await settleInteractiveLiveActivity(client,{
          principalId: auth.principalId, notificationEventId: row.notification_event_id,
          responseState: "canceled", apnsMode: dependencies?.apnsMode ?? "disabled",
        });
        row = (await client.query<any>(
          `${interactionResultSelection} WHERE r.id=$1 AND r.principal_id=$2 AND e.requester_credential_id=$3`,
          [interactionId,auth.principalId,auth.credentialId],
        )).rows[0]!;
      }
      await client.query("COMMIT");
      return context.json({ interaction: interactionResource(row) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  };
  app.post("/api/interactions/:interactionId/cancel", requireScope("interactions:create"), cancelInteraction);
  app.delete("/api/interactions/:interactionId", requireScope("interactions:create"), cancelInteraction);

  app.get("/api/interactions/:interactionId/wait", requireScope("interactions:read"), async (context) => {
    const auth = context.get("auth");
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const interactionId = internalId("int", context.req.param("interactionId") ?? "");
    if (!interactionId) return context.json({ error: "not_found" }, 404);
    const timeoutSeconds = Math.min(Math.max(Number(context.req.query("timeoutSeconds") ?? 60), 0), 300);
    const deadline = Date.now() + timeoutSeconds * 1000;
    do {
      const result = await db.query<any>(
        `${interactionResultSelection}
         WHERE r.id=$1 AND r.principal_id=$2 AND e.requester_credential_id=$3`,
        [interactionId,auth.principalId,auth.credentialId],
      );
      if (!result.rowCount) return context.json({ error: "not_found" }, 404);
      const row = result.rows[0]!;
      if (row.state !== "pending") return context.json({ interaction: interactionResource(row) });
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        const client = await db.connect();
        try {
          await client.query("BEGIN");
          const expired = await client.query<{ notification_event_id: string }>(
            `UPDATE interaction_requests SET state='expired',responded_at=now()
             WHERE id=$1 AND principal_id=$2 AND state='pending'
               AND EXISTS (
                 SELECT 1 FROM notification_events owned
                 WHERE owned.id=interaction_requests.notification_event_id
                   AND owned.requester_credential_id=$3
               )
             RETURNING notification_event_id`,
            [interactionId,auth.principalId,auth.credentialId],
          );
          if (expired.rowCount) {
            await client.query(
              "UPDATE notification_events SET state='expired',updated_at=now() WHERE id=$1",
              [expired.rows[0]!.notification_event_id],
            );
            await settleInteractiveLiveActivity(client,{
              principalId: auth.principalId, notificationEventId: expired.rows[0]!.notification_event_id,
              responseState: "expired", apnsMode: dependencies?.apnsMode ?? "disabled",
            });
          }
          const terminal = await client.query<any>(
            `${interactionResultSelection}
             WHERE r.id=$1 AND r.principal_id=$2 AND e.requester_credential_id=$3`,
            [interactionId,auth.principalId,auth.credentialId],
          );
          await client.query("COMMIT");
          const winner = terminal.rows[0]!;
          return context.json({ interaction: interactionResource(winner) });
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally { client.release(); }
      }
      if (Date.now() >= deadline) return context.json({ interaction: interactionResource(row) });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (true);
  });

  app.get("/api/inbox", requireScope("inbox:read"), async (context) => {
    const auth = context.get("auth");
    const limit = Math.min(Math.max(Number(context.req.query("limit") ?? 20), 1), 100);
    const after = context.req.query("after") ?? context.req.query("cursor");
    const cursor = decodeCursor(after);
    if (after && !cursor) return context.json({ error: "cursor_expired" }, 410);
    const queryValues: unknown[] = [
      auth.principalId,
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
    ];
    if (auth.deviceId) queryValues.push(auth.deviceId);
    const result = await db.query<any>(
      `WITH window_candidates AS MATERIALIZED (
         SELECT candidate.id,candidate.updated_at
         FROM notification_events candidate
         WHERE candidate.principal_id=$1
           ${auth.deviceId ? `AND (candidate.target_mode='broadcast' OR EXISTS (
             SELECT 1 FROM notification_event_targets retained_target
             WHERE retained_target.notification_event_id=candidate.id AND retained_target.device_id=$4
         ))` : ""}
         ORDER BY candidate.updated_at DESC,candidate.id DESC
         LIMIT ${mobileInboxSyncWindow + 1}
       ), scoped AS MATERIALIZED (
         SELECT candidate.id,candidate.updated_at
         FROM window_candidates candidate
         ORDER BY candidate.updated_at DESC,candidate.id DESC
         LIMIT ${mobileInboxSyncWindow}
       ), metadata AS (
         SELECT NOT (
           $2::timestamptz IS NOT NULL
           AND (SELECT count(*) FROM window_candidates) > ${mobileInboxSyncWindow}
           AND ($2::timestamptz,$3::uuid) < (
             SELECT retained.updated_at,retained.id
             FROM scoped retained
             ORDER BY retained.updated_at ASC,retained.id ASC
             LIMIT 1
           )
         ) AS cursor_valid
       ), page AS (
       SELECT e.*,
        ${inboxActivityProjectionSql},
        to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
        e.updated_at AS sync_at,
        to_char(e.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sync_at_iso,
        r.id AS interaction_id,r.kind AS interaction_kind,r.prompt AS interaction_prompt,
        r.state AS interaction_state,r.expires_at AS interaction_expires_at,
        r.responded_at AS interaction_responded_at,
        (SELECT CASE WHEN j.provider_outcome_category='invalid-recipient' THEN 'token_invalid' ELSE j.state END
          FROM delivery_jobs j WHERE j.notification_event_id=e.id
          ${auth.deviceId ? "AND j.device_id=$4" : ""} ORDER BY j.updated_at DESC LIMIT 1) AS delivery_state,
        (SELECT accepted_at FROM delivery_jobs j WHERE j.notification_event_id=e.id
          ${auth.deviceId ? "AND j.device_id=$4" : ""} ORDER BY j.updated_at DESC LIMIT 1) AS accepted_at,
        (SELECT created_at FROM interactions i WHERE i.notification_event_id=e.id AND i.kind='received' ORDER BY created_at DESC LIMIT 1) AS received_at,
        (SELECT created_at FROM interactions i WHERE i.notification_event_id=e.id AND i.kind='opened' ORDER BY created_at DESC LIMIT 1) AS opened_at
       FROM scoped retained
       JOIN notification_events e ON retained.id=e.id
       ${inboxActivityJoinSql}
       LEFT JOIN interaction_requests r ON r.notification_event_id=e.id
       WHERE e.principal_id=$1 AND ($2::timestamptz IS NULL OR (e.updated_at,e.id)>($2::timestamptz,$3::uuid))
         ${auth.deviceId ? `AND (e.target_mode='broadcast' OR EXISTS (
           SELECT 1 FROM notification_event_targets t
           WHERE t.notification_event_id=e.id AND t.device_id=$4
         ))` : ""}
       ORDER BY e.updated_at ASC,e.id ASC LIMIT ${limit + 1}
       )
       SELECT page.*,metadata.cursor_valid
       FROM metadata LEFT JOIN page ON metadata.cursor_valid
       ORDER BY page.updated_at ASC,page.id ASC`,
      queryValues,
    );
    const metadata = result.rows[0] as { id: string | null; cursor_valid: boolean } | undefined;
    if (!metadata?.cursor_valid) return context.json({ error: "cursor_expired" },410);
    const pageRows = result.rows.filter((row: any) => row.id !== null);
    const hasMore = pageRows.length > limit;
    const rows = pageRows.slice(0, limit);
    const last = rows.at(-1);
    const readMetadata = await inboxReadMetadata(db,auth.principalId,auth.deviceId);
    return context.json({
      items: rows.map((row: any) => inboxItemResource(
        row,auth,integratedDependencies?.credentialDerivationSecret,notificationContentCipher ?? undefined,
      )),
      cursor: last ? encodeCursor(last.sync_at_iso,last.id) : (after ?? null),
      hasMore,
      serverTime: new Date().toISOString(),
      ...readMetadata,
    });
  });

  app.get("/api/inbox/history", requireScope("inbox:read"), async (context) => {
    const auth = context.get("auth");
    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (rawLimit !== undefined && !/^\d+$/.test(rawLimit))) {
      return context.json({ error: "invalid_limit" },400);
    }
    const before = context.req.query("before");
    const cursor = decodeInboxHistoryCursor(before);
    if (before !== undefined && !cursor) return context.json({ error: "cursor_expired" },410);

    const queryValues: unknown[] = [
      auth.principalId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
    ];
    if (auth.deviceId) queryValues.push(auth.deviceId);
    const result = await db.query<any>(
      `WITH scoped AS MATERIALIZED (
         SELECT retained.id,retained.created_at FROM (
           SELECT e.id,e.created_at
           FROM notification_events e
           WHERE e.principal_id=$1
             ${auth.deviceId ? `AND (e.target_mode='broadcast' OR EXISTS (
               SELECT 1 FROM notification_event_targets target
               WHERE target.notification_event_id=e.id AND target.device_id=$4
             ))` : ""}
           ORDER BY e.created_at DESC,e.id DESC
           LIMIT ${mobileInboxHistoryWindow}
         ) retained
       ), metadata AS (
         SELECT count(*)::int AS total,
           ($2::timestamptz IS NULL OR EXISTS (
             SELECT 1 FROM scoped anchor WHERE (anchor.created_at,anchor.id)=($2::timestamptz,$3::uuid)
           )) AS cursor_valid
         FROM scoped
       ), page AS (
         SELECT e.*,
           ${inboxActivityProjectionSql},
           to_char(visible.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
           to_char(visible.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS history_cursor_at,
           r.id AS interaction_id,r.kind AS interaction_kind,r.prompt AS interaction_prompt,
           r.state AS interaction_state,r.expires_at AS interaction_expires_at,
           r.responded_at AS interaction_responded_at,
           (SELECT CASE WHEN j.provider_outcome_category='invalid-recipient' THEN 'token_invalid' ELSE j.state END
             FROM delivery_jobs j WHERE j.notification_event_id=e.id
             ${auth.deviceId ? "AND j.device_id=$4" : ""} ORDER BY j.updated_at DESC LIMIT 1) AS delivery_state,
           (SELECT accepted_at FROM delivery_jobs j WHERE j.notification_event_id=e.id
             ${auth.deviceId ? "AND j.device_id=$4" : ""} ORDER BY j.updated_at DESC LIMIT 1) AS accepted_at,
           (SELECT created_at FROM interactions i WHERE i.notification_event_id=e.id AND i.kind='received'
             ORDER BY created_at DESC LIMIT 1) AS received_at,
           (SELECT created_at FROM interactions i WHERE i.notification_event_id=e.id AND i.kind='opened'
             ORDER BY created_at DESC LIMIT 1) AS opened_at
         FROM scoped visible
         JOIN notification_events e ON e.id=visible.id
         ${inboxActivityJoinSql}
         LEFT JOIN interaction_requests r ON r.notification_event_id=e.id
         WHERE ($2::timestamptz IS NULL OR (visible.created_at,visible.id)<($2::timestamptz,$3::uuid))
         ORDER BY visible.created_at DESC,visible.id DESC
         LIMIT ${limit + 1}
       )
       SELECT page.*,metadata.total,metadata.cursor_valid
       FROM metadata LEFT JOIN page ON metadata.cursor_valid
       ORDER BY page.created_at DESC,page.id DESC`,
      queryValues,
    );
    const metadata = result.rows[0] as { id: string | null; total: number; cursor_valid: boolean } | undefined;
    if (!metadata?.cursor_valid) return context.json({ error: "cursor_expired" },410);
    const pageRows = result.rows.filter((row: any) => row.id !== null);
    const hasMore = pageRows.length > limit;
    const rows = pageRows.slice(0,limit);
    const last = rows.at(-1);
    const readMetadata = await inboxReadMetadata(db,auth.principalId,auth.deviceId);
    return context.json({
      items: rows.map((row: any) => inboxItemResource(
        row,auth,integratedDependencies?.credentialDerivationSecret,notificationContentCipher ?? undefined,
      )),
      cursor: hasMore && last ? encodeInboxHistoryCursor(last.history_cursor_at,last.id) : null,
      hasMore,
      total: metadata.total,
      serverTime: new Date().toISOString(),
      ...readMetadata,
    });
  });

  app.post("/api/inbox/read", requireScope("inbox:read"), async (context) => {
    const auth = context.get("auth");
    const input = inboxReadMutationSchema.parse(await context.req.json());
    if (input.notificationId) {
      const eventId = internalId("ntf", input.notificationId);
      if (!eventId) return context.json({ error: "not_found" },404);
      const result = await db.query<any>(
        `WITH target AS (
           SELECT id,read_at FROM notification_events WHERE id=$1 AND principal_id=$2
         ), updated AS (
           UPDATE notification_events SET read_at=now(),updated_at=updated_at
           WHERE id IN (SELECT id FROM target) AND read_at IS NULL RETURNING read_at
         )
         SELECT EXISTS(SELECT 1 FROM target) AS found,
           EXISTS(SELECT 1 FROM updated) AS changed,
           COALESCE((SELECT read_at FROM updated),(SELECT read_at FROM target)) AS read_at`,
        [eventId,auth.principalId],
      );
      if (!result.rows[0]?.found) return context.json({ error: "not_found" },404);
      return context.json({ changed: Boolean(result.rows[0]!.changed),readAt: result.rows[0]!.read_at,
        ...(await inboxReadMetadata(db,auth.principalId,auth.deviceId)) });
    }
    const watermark = decodeCursor(input.watermark);
    if (!watermark) return context.json({ error: "invalid_read_watermark" },400);
    const boundary = await db.query(
      `SELECT 1 FROM notification_events WHERE principal_id=$1 AND created_at=$2::timestamptz AND id=$3::uuid`,
      [auth.principalId,watermark[0],watermark[1]],
    );
    if (!boundary.rowCount) return context.json({ error: "invalid_read_watermark" },409);
    const result = await db.query(
      `UPDATE notification_events SET read_at=COALESCE(read_at,now()),updated_at=updated_at
       WHERE principal_id=$1 AND read_at IS NULL AND withdrawn_at IS NULL
         AND (created_at,id)<=($2::timestamptz,$3::uuid)`,
      [auth.principalId,watermark[0],watermark[1]],
    );
    return context.json({ changed: result.rowCount ?? 0,
      ...(await inboxReadMetadata(db,auth.principalId,auth.deviceId)) });
  });

  app.get("/api/inbox/live-activities/active", requireScope("inbox:read"), async (context) => {
    const auth = context.get("auth");
    await expireDueActivities(db,apnsMode);
    const values: unknown[] = [auth.principalId];
    if (auth.deviceId) values.push(auth.deviceId);
    const result = await db.query<any>(
      `SELECT activity.id AS active_id,activity.generation,
         event.id,event.principal_id,event.payload,
         to_char(event.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
         interaction.id AS interaction_id,interaction.kind AS interaction_kind,
         interaction.state AS interaction_state,interaction.expires_at AS interaction_expires_at,
         ${auth.deviceId ? `(SELECT job.state FROM delivery_jobs job
           WHERE job.notification_event_id=event.id AND job.device_id=$2
           ORDER BY job.updated_at DESC LIMIT 1)` : "NULL"} AS delivery_state
       FROM live_activities activity
       LEFT JOIN LATERAL (
         SELECT candidate.* FROM notification_events candidate
         WHERE candidate.principal_id=activity.principal_id
           AND candidate.kind='live_activity'
           AND candidate.payload#>>'{liveActivity,activityId}'=('act_'||activity.id::text)
           AND candidate.payload#>>'{liveActivity,generation}'=activity.generation::text
           ${auth.deviceId ? `AND (candidate.target_mode='broadcast' OR EXISTS (
             SELECT 1 FROM notification_event_targets target
             WHERE target.notification_event_id=candidate.id AND target.device_id=$2
           ))` : ""}
         ORDER BY candidate.created_at DESC,candidate.id DESC
         LIMIT 1
       ) event ON true
       LEFT JOIN interaction_requests interaction ON interaction.notification_event_id=event.id
       WHERE activity.principal_id=$1 AND activity.state='active'
       ORDER BY activity.id,activity.generation`,
      values,
    );
    return context.json({ activities: result.rows.map((row) => ({
      id: publicId("act",row.active_id),generation: Number(row.generation),
      eventId: row.id ? publicId("ntf",row.id) : null,
      createdAt: row.created_at_iso ?? null,
      command: row.id ? projectedInboxLiveActivity(
        row.payload,row,auth.deviceId,auth.deviceCredentialVersion,
        integratedDependencies?.credentialDerivationSecret,
      ) : null,
    })) });
  });

  app.get("/api/inbox/:notificationId", requireScope("inbox:read"), async (context) => {
    const auth = context.get("auth");
    const eventId = internalId("ntf",context.req.param("notificationId") ?? "");
    if (!eventId) return context.json({ error: "not_found" },404);
    const values: unknown[] = [eventId,auth.principalId];
    if (auth.deviceId) values.push(auth.deviceId);
    const result = await db.query<any>(
      `SELECT e.*,${inboxActivityProjectionSql},
        to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
        r.id AS interaction_id,r.kind AS interaction_kind,r.prompt AS interaction_prompt,
        r.state AS interaction_state,r.expires_at AS interaction_expires_at,
        r.responded_at AS interaction_responded_at,
        (SELECT CASE WHEN j.provider_outcome_category='invalid-recipient' THEN 'token_invalid' ELSE j.state END
          FROM delivery_jobs j WHERE j.notification_event_id=e.id
          ${auth.deviceId ? "AND j.device_id=$3" : ""} ORDER BY j.updated_at DESC LIMIT 1) AS delivery_state,
        (SELECT accepted_at FROM delivery_jobs j WHERE j.notification_event_id=e.id
          ${auth.deviceId ? "AND j.device_id=$3" : ""} ORDER BY j.updated_at DESC LIMIT 1) AS accepted_at,
        (SELECT created_at FROM interactions i WHERE i.notification_event_id=e.id AND i.kind='received'
          ORDER BY created_at DESC LIMIT 1) AS received_at,
        (SELECT created_at FROM interactions i WHERE i.notification_event_id=e.id AND i.kind='opened'
          ORDER BY created_at DESC LIMIT 1) AS opened_at
       FROM notification_events e ${inboxActivityJoinSql}
       LEFT JOIN interaction_requests r ON r.notification_event_id=e.id
       WHERE e.id=$1 AND e.principal_id=$2
         ${auth.deviceId ? `AND (e.target_mode='broadcast' OR EXISTS (
           SELECT 1 FROM notification_event_targets target
           WHERE target.notification_event_id=e.id AND target.device_id=$3
         ))` : ""}`,
      values,
    );
    if (!result.rowCount) return context.json({ error: "not_found" },404);
    const [deliveries,interactions,withdrawals,timeline] = await Promise.all([
      db.query<any>(
        `SELECT id,device_id,transport,state,attempt_count,provider_outcome_category,
           last_error_code,accepted_at,created_at,updated_at
         FROM delivery_jobs WHERE notification_event_id=$1
           ${auth.deviceId ? "AND device_id=$2" : ""} ORDER BY created_at,id`,
        auth.deviceId ? [eventId,auth.deviceId] : [eventId],
      ),
      db.query<any>(
        `SELECT kind,created_at FROM interactions WHERE notification_event_id=$1
           ${auth.deviceId ? "AND device_id=$2" : ""} ORDER BY created_at,id`,
        auth.deviceId ? [eventId,auth.deviceId] : [eventId],
      ),
      db.query<any>(
        `SELECT device_id,outcome,detail_code,created_at FROM notification_withdrawal_evidence
         WHERE notification_event_id=$1 ${auth.deviceId ? "AND (device_id IS NULL OR device_id=$2)" : ""}
         ORDER BY created_at,id`,auth.deviceId ? [eventId,auth.deviceId] : [eventId],
      ),
      loadDeliveryEvidence(db,auth.principalId,{
        notificationId: publicId("ntf",eventId),deviceId: auth.deviceId ?? null,limit: 100,
      }),
    ]);
    return context.json({
      item: inboxItemResource(result.rows[0],auth,integratedDependencies?.credentialDerivationSecret,
        notificationContentCipher ?? undefined),
      evidence: {
        version: timeline.version,
        timeline: timeline.items,
        deliveries: deliveries.rows.map((row) => ({
          id: publicId("job",row.id),
          deviceId: row.device_id ? publicId("dev",row.device_id) : null,
          transport: row.transport,state: row.state,attemptCount: Number(row.attempt_count),
          providerOutcome: row.provider_outcome_category ?? null,
          errorCode: row.last_error_code ?? null,acceptedAt: row.accepted_at ?? null,
          createdAt: row.created_at,updatedAt: row.updated_at,
        })),
        interactions: interactions.rows.map((row) => ({
          kind: row.kind,createdAt: row.created_at,
        })),
        withdrawals: withdrawals.rows.map((row) => ({
          deviceId: row.device_id ? publicId("dev",row.device_id) : null,
          outcome: row.outcome,detailCode: row.detail_code ?? null,createdAt: row.created_at,
        })),
      },
    });
  });

  app.post("/api/notifications/:notificationId/withdraw", requireScope("notifications:send"), async (context) => {
    const auth = context.get("auth");
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const eventId = internalId("ntf",context.req.param("notificationId") ?? "");
    if (!eventId) return context.json({ error: "not_found" },404);
    const idempotencyKey = z.string().trim().min(1).max(200).parse(
      context.req.header("idempotency-key") ?? `server:${randomUUID()}`,
    );
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const event = await client.query<any>(
        `SELECT id,state,withdrawn_at FROM notification_events
         WHERE id=$1 AND principal_id=$2 AND requester_credential_id=$3
           AND kind<>'live_activity' FOR UPDATE`,
        [eventId,auth.principalId,auth.credentialId],
      );
      if (!event.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "not_found" },404);
      }
      if (event.rows[0]!.withdrawn_at) {
        await client.query("COMMIT");
        return context.json({ eventId: publicId("ntf",eventId),state: "withdrawn",
          withdrawnAt: event.rows[0]!.withdrawn_at,replayed: true });
      }
      const withdrawn = await client.query<any>(
        `UPDATE notification_events SET state='withdrawn',withdrawn_at=now(),
           withdrawn_by_kind='credential',withdrawn_by_id=$3,updated_at=now()
         WHERE id=$1 AND principal_id=$2 RETURNING withdrawn_at`,
        [eventId,auth.principalId,auth.credentialId],
      );
      await client.query(
        `UPDATE interaction_requests SET state='canceled',responded_at=now()
         WHERE notification_event_id=$1 AND state='pending'`,
        [eventId],
      );
      const canceled = await client.query(
        `UPDATE delivery_jobs SET state='canceled',updated_at=now(),last_error_code='notification_withdrawn'
         WHERE notification_event_id=$1 AND state IN ('pending','retry') RETURNING id`,
        [eventId],
      );
      await client.query(
        `INSERT INTO notification_withdrawal_evidence(
           principal_id,notification_event_id,requester_kind,requester_id,idempotency_key,outcome
         ) VALUES ($1,$2,'credential',$3,$4,'canonical_withdrawn')`,
        [auth.principalId,eventId,auth.credentialId,idempotencyKey],
      );
      if ((canceled.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO notification_withdrawal_evidence(
             principal_id,notification_event_id,requester_kind,requester_id,idempotency_key,outcome,detail_code
           ) VALUES ($1,$2,'credential',$3,$4,'pending_delivery_canceled',$5)`,
          [auth.principalId,eventId,auth.credentialId,idempotencyKey,String(canceled.rowCount)],
        );
      }
      await client.query(
        `INSERT INTO notification_withdrawal_evidence(
           principal_id,notification_event_id,device_id,requester_kind,requester_id,
           idempotency_key,outcome,detail_code
         )
         SELECT $1,$2,d.id,'credential',$3,$4,'sync_command_queued','inbox_tombstone'
         FROM devices d WHERE d.principal_id=$1 AND d.revoked_at IS NULL`,
        [auth.principalId,eventId,auth.credentialId,idempotencyKey],
      );
      await client.query("COMMIT");
      return context.json({ eventId: publicId("ntf",eventId),state: "withdrawn",
        withdrawnAt: withdrawn.rows[0]!.withdrawn_at,canceledDeliveries: canceled.rowCount ?? 0,
        replayed: false });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as any)?.code === "23505") {
        const existing = await db.query<any>(
          `SELECT withdrawn_at FROM notification_events WHERE id=$1 AND principal_id=$2
           AND requester_credential_id=$3`,
          [eventId,auth.principalId,auth.credentialId],
        );
        if (existing.rows[0]?.withdrawn_at) return context.json({ eventId: publicId("ntf",eventId),
          state: "withdrawn",withdrawnAt: existing.rows[0].withdrawn_at,replayed: true });
      }
      throw error;
    } finally { client.release(); }
  });

  app.post("/api/notifications/:notificationId/interactions", requireScope("interactions:respond"), async (context) => {
    const auth = context.get("auth");
    if (!auth.deviceId) return context.json({ error: "device_credential_required" }, 403);
    const eventId = internalId("ntf", context.req.param("notificationId") ?? "");
    if (!eventId) return context.json({ error: "not_found" }, 404);
    const input = await jsonBody(context, interactionSchema);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const responseStates: Record<string, string> = {
        approve: "approved",
        deny: "denied",
        yes: "yes",
        no: "no",
        answer: "replied",
      };
      const responseState = responseStates[input.kind];
      const event = await client.query<any>(
        `SELECT e.id,e.payload FROM notification_events e
         WHERE e.id=$1 AND e.principal_id=$3
           AND ($4::boolean=false OR EXISTS (
             SELECT 1 FROM devices d WHERE d.id=$2 AND d.principal_id=$3
               AND d.revoked_at IS NULL
           ))
           AND (e.target_mode='broadcast' OR EXISTS (
             SELECT 1 FROM notification_event_targets t
             WHERE t.notification_event_id=e.id AND t.device_id=$2
           ))`,
        [eventId,auth.deviceId,auth.principalId,Boolean(responseState)],
      );
      if (!event.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "not_found" },404);
      }
      const request = responseState ? await client.query<any>(
        `SELECT id,kind,state,expires_at FROM interaction_requests
         WHERE notification_event_id=$1 AND principal_id=$2 FOR UPDATE`,
        [eventId,auth.principalId],
      ) : null;
      if (responseState) {
        if (!request?.rowCount) {
          await client.query("ROLLBACK");
          return context.json({ error: "interaction_not_found" },404);
        }
        const kindMatches = request.rows[0].kind === "approval"
          ? ["approved","denied"].includes(responseState)
          : request.rows[0].kind === "yes_no"
            ? ["yes","no"].includes(responseState)
            : responseState === "replied";
        if (!kindMatches) {
          await client.query("ROLLBACK");
          return context.json({ error: "invalid_action" },400);
        }
      }
      const replay = await client.query<any>(
        `SELECT id,notification_event_id,interaction_request_id,device_id,kind,value
         FROM interactions WHERE principal_id=$1 AND idempotency_key=$2`,
        [auth.principalId,input.idempotencyKey],
      );
      if (replay.rowCount) {
        const row = replay.rows[0];
        const exact = row.notification_event_id === eventId && row.device_id === auth.deviceId
          && row.kind === input.kind && stableJson(row.value) === stableJson(input.value)
          && row.interaction_request_id === (request?.rows[0]?.id ?? null);
        await client.query(exact ? "COMMIT" : "ROLLBACK");
        return exact
          ? context.json({ interactionId: publicId("int",row.id), replayed: true })
          : context.json({ error: "idempotency_conflict" },409);
      }
      if (responseState && (request!.rows[0].state !== "pending"
        || new Date(request!.rows[0].expires_at).getTime() <= Date.now())) {
        if (request!.rows[0].state === "pending") {
          await client.query("UPDATE interaction_requests SET state='expired',responded_at=now() WHERE id=$1",[request!.rows[0].id]);
          await client.query("UPDATE notification_events SET state='expired',updated_at=now() WHERE id=$1",[eventId]);
          await settleInteractiveLiveActivity(client,{
            principalId: auth.principalId, notificationEventId: eventId,
            responseState: "expired", apnsMode: dependencies?.apnsMode ?? "disabled",
          });
          await client.query("COMMIT");
        } else await client.query("ROLLBACK");
        const state = request!.rows[0].state === "pending" ? "expired" : request!.rows[0].state;
        return context.json({ error: "interaction_not_pending", state },409);
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO interactions(
           principal_id,notification_event_id,interaction_request_id,device_id,kind,value,idempotency_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (principal_id,idempotency_key) DO NOTHING RETURNING id`,
        [auth.principalId,eventId,request?.rows[0]?.id ?? null,auth.deviceId,input.kind,input.value,input.idempotencyKey],
      );
      if (!result.rowCount) {
        const raced = await client.query<any>(
          `SELECT id,notification_event_id,interaction_request_id,device_id,kind,value
           FROM interactions WHERE principal_id=$1 AND idempotency_key=$2`,
          [auth.principalId,input.idempotencyKey],
        );
        const row = raced.rows[0];
        const exact = Boolean(row) && row.notification_event_id === eventId && row.device_id === auth.deviceId
          && row.kind === input.kind && stableJson(row.value) === stableJson(input.value)
          && row.interaction_request_id === (request?.rows[0]?.id ?? null);
        await client.query(exact ? "COMMIT" : "ROLLBACK");
        return exact
          ? context.json({ interactionId: publicId("int",row.id), replayed: true })
          : context.json({ error: "idempotency_conflict" },409);
      }
      if (responseState) {
        const answered = await client.query<{ id: string }>(
          `UPDATE interaction_requests
           SET state=$3::interaction_request_state,response=$4,responded_at=now()
           WHERE notification_event_id=$1 AND principal_id=$2
             AND state='pending' AND expires_at>now()
             AND (
               (kind='approval' AND $3::interaction_request_state IN ('approved','denied')) OR
               (kind='yes_no' AND $3::interaction_request_state IN ('yes','no')) OR
               (kind='text' AND $3::interaction_request_state='replied')
             )
           RETURNING id`,
          [eventId,auth.principalId,responseState,input.value],
        );
        if (!answered.rowCount) {
          throw new Error("interaction settlement lost its request lock");
        }
        await client.query(
          "UPDATE notification_events SET state='responded',updated_at=now() WHERE id=$1 AND principal_id=$2",
          [eventId,auth.principalId],
        );
        await settleInteractiveLiveActivity(client,{
          principalId: auth.principalId, notificationEventId: eventId,
          responseState: responseState as "approved" | "denied" | "yes" | "no",
          apnsMode: dependencies?.apnsMode ?? "disabled",
        });
      } else {
        await client.query(
          "UPDATE notification_events SET updated_at=now() WHERE id=$1 AND principal_id=$2",
          [eventId,auth.principalId],
        );
        if (input.kind === "received") {
          const command = event.rows[0]?.payload?.liveActivity;
          const activityId = internalId("act",command?.activityId ?? "");
          const operation = command?.operation;
          const sequence = Number(command?.sequence);
          if (activityId && ["start","update","end"].includes(operation)
            && Number.isSafeInteger(sequence) && sequence >= 0) {
            await markActivityPresentationApplied(client,{
              principalId: auth.principalId,activityId,deviceId: auth.deviceId,
              operation: operation as "start" | "update" | "end",sequence,
            });
          }
        }
      }
      await client.query("COMMIT");
      return context.json({ interactionId: publicId("int",result.rows[0]!.id), replayed: false }, 201);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  registerActivityRoutes(app, db, dependencies?.apnsMode ?? "disabled");

  return app;
}
