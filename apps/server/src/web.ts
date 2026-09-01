import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import {
  LIVE_ACTIVITY_PRESET_IDS,
  liveActivityPresentationPolicySchema,
  liveActivityPresentationSchema,
  type LiveActivityPresentation,
} from "@relo/notification-contracts";
import { httpsUrlSchema, publicHttpsUrlSchema } from "./url-policy.js";
import type { Hono } from "hono";
import { z } from "zod";
import type { AccountAuth, AccountSession } from "./account-auth.js";
import { getAccountSession } from "./account-auth.js";
import {
  cancelPendingActivityInteractions, liveActivityStyles, serializeTaskActivity,
  taskActivityRequestHash, expireDueActivities, type ApnsMode,
} from "./activities.js";
import { generateToken, hashToken } from "./auth.js";
import type { Database } from "./db.js";
import { internalId, publicId } from "./ids.js";
import { createNotificationContentCipher } from "./notification-content.js";
import { createWebhookService, rotateWebhookService } from "./services.js";
import {
  dashboardPageNumber,
  dashboardReleaseIdentity,
  dashboardScript,
  dashboardStyles,
  renderDashboardDocument,
  renderDashboardTabs,
  renderOneTimeServiceSecretPanel,
  renderDashboardPager,
  renderDocument,
  type DashboardSection,
} from "./web/dashboard-ui.js";
import {
  createTestLabDashboardBootstrap,
  dashboardAppAssetResponse,
  renderDashboardAppDocument,
} from "./web/dashboard-app.js";
import { createDashboardInboxHandlers } from "./web/dashboard-inbox.js";
import { createDashboardActivityHistoryHandler } from "./web/dashboard-activity-history.js";
import { createDashboardProjectHandlers } from "./web/dashboard-projects.js";
import { createDashboardSystemHandlers } from "./web/dashboard-system.js";
import { createDashboardConnectionsHandlers } from "./web/dashboard-connections.js";
import { agentsMarkdown, documentationMarkdown, llmsText } from "./web/docs-content.js";
import { lockAccountLifecycle } from "./account-lifecycle.js";
import { createConnectionGrant } from "./connection-grants.js";
import { assertOwnerRole, createAccountUser, resetAccountUserPassword } from "./user-admin.js";
import { apnsTransportTruth } from "./delivery-observability.js";
import {
  DeliveryReconciliationError,deliveryReconciliationActions,reconcileDeliveryJob,
} from "./delivery-reconciliation.js";
import {
  canonicalOriginHash,dashboardTestLabOrigin,lockOriginGenerationSlot,originGenerationMetadata,
} from "./origin-slots.js";
import {
  canonicalPresentation,
  persistedPresentationColumns,
  presentationCommandProjection,
  presentationFromRow,
  terminalPresentationFromRow,
} from "./presentation-runtime.js";
import {
  ActivityPrivacyPolicyError,
  applyActivityPrivacyPolicy,
  resolveActivityPresentation,
  loadAccountPresentationPolicy,
  parsePresentationPolicy,
  SYSTEM_PRESENTATION_POLICY,
  systemPresentationPolicySnapshot,
  type EffectivePresentationPolicy,
} from "./presentation-policy.js";
import { syncActivityPresentationLease } from "./activity-presentation-leases.js";
import { beginActivityTransaction } from "./activity-lifecycle-domain.js";
import {
  recordActivityCorrelationDecision,
  recordActivityStartEvidence,
} from "./activity-relationships.js";

export type WebAuthDependencies = {
  accountAuth: AccountAuth;
  bootstrapOwnerHandle: string;
  appUrl: string;
  credentialDerivationSecret: string;
  apnsMode: ApnsMode;
  reconcileActivities?: () => Promise<number>;
};

export type OwnerAccount = AccountSession & { principalId: string; accountId: string };

const liveActivityGallery = {
  standard: { label: "Standard", headline: "Release #42", status: "Building", detail: "Compiling the Relo notification pipeline", progress: 0.42 },
  hero: { label: "Hero", headline: "Release #42", status: "Building", detail: "Compiling the Relo notification pipeline", progress: 0.42 },
  terminal: { label: "Terminal", headline: "Release #42", status: "building", detail: "Compiling the Relo notification pipeline", progress: 0.42 },
  steps: { label: "Steps", headline: "Release #42", status: "Step 3 of 5", detail: "Testing notification delivery", progress: 0.6 },
  approval: { label: "Approval", headline: "Approval needed", status: "Review", detail: "Deploy release #42 to Relo server?", progress: null },
  shell: { label: "Shell", headline: "Approval needed", status: "Awaiting", detail: "Deploy release #42 to Relo server?", progress: null },
  verdict: { label: "Verdict", headline: "Decision required", status: "Review", detail: "Deploy release #42 to Relo server?", progress: null },
  signal: { label: "Signal", headline: "Guarded action", status: "Urgent", detail: "Deploy release #42 to Relo server?", progress: null },
} satisfies Record<(typeof liveActivityStyles)[number], { label: string; headline: string; status: string; detail: string; progress: number | null }>;

const liveActivityVisualContract = {
  standard: { accent: "#47E8B8", secondary: "#08755C", layout: "standard-stack", lock: "source,status,headline,detail,progress", bottom: "headline,detail,progress" },
  hero: { accent: "#FF7A40", secondary: "#D1297A", layout: "hero-stack", lock: "source,symbol,status,headline,detail,progress", bottom: "status,headline" },
  terminal: { accent: "#4DF594", secondary: "#056B4D", layout: "terminal-stack", lock: "source,status,command,detail,progress", bottom: "command,detail" },
  steps: { accent: "#8FADFF", secondary: "#38D1E0", layout: "steps-stack", lock: "source,status,headline,steps,detail", bottom: "headline,detail,steps" },
  approval: { accent: "#FF943D", secondary: "#BF331A", layout: "approval-stack", lock: "source,status,shield,headline,detail,actions", bottom: "shield,headline,detail,actions" },
  shell: { accent: "#45ED9E", secondary: "#0D96B8", layout: "shell-stack", lock: "path,status,command,detail,actions", bottom: "command,actions" },
  verdict: { accent: "#5CA8FF", secondary: "#783DF0", layout: "verdict-stack", lock: "seal,status,headline,detail,actions", bottom: "seal,headline,detail,actions" },
  signal: { accent: "#FF5E45", secondary: "#FFAD33", layout: "signal-row", lock: "symbol,status,source,headline,detail,actions", bottom: "symbol,headline,detail,actions" },
} satisfies Record<(typeof liveActivityStyles)[number], {
  accent: string; secondary: string; layout: string; lock: string; bottom: string;
}>;

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
  const presentation = resolved.stored.presentation;
  const stored = resolved.stored;
  const interactionKind = stored.presentation.behavior.type === "approval" ? "approval"
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

function dashboardBuilderPresetPresentation(
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
      roles: { cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state" } },
    privacy: "standard",
  });
}

const dashboardActivityUpdateSchema = z.object({
  presentation: liveActivityPresentationSchema,
}).strict();

const dashboardActivityWaitSchema = z.object({
  kind: z.enum(["approval","yes_no","text"]).default("approval"),
  prompt: z.string().min(1).max(240),
}).strict();

const dashboardActivityEndSchema = z.object({
  dismissAfterSeconds: z.number().int().min(0).max(14400).default(0),
}).strict();

function dashboardTerminalPresentation(row: any): LiveActivityPresentation {
  return terminalPresentationFromRow(row,"Finished","success");
}

function dashboardPresentationAccent(presentation: LiveActivityPresentation): string {
  return presentation.identity.thread?.color ?? presentation.identity.project?.color ?? "#5ED8B7";
}

function dashboardPresentationProgress(presentation: LiveActivityPresentation): number | null {
  const measured = presentation.components.find((component) => component.type === "progress_bar");
  if (measured?.type === "progress_bar") return measured.value;
  const steps = presentation.components.find((component) => component.type === "steps");
  return steps?.type === "steps"
    ? steps.items.filter((item) => item.state === "complete").length / steps.items.length
    : null;
}

function dashboardPresentationVisualSummary(presentation: LiveActivityPresentation): string {
  return presentation.components.map((component) => component.type).join(" + ") || "none";
}

const dashboardHistoryPageSize = 25;
const dashboardNotificationKinds = ["notification","approval","question","live_activity"] as const;
const dashboardNotificationStates = ["active","responded","expired","canceled"] as const;

async function recordDashboardActivityOperation(
  client: any,
  input: {
    principalId: string; activity: any; operation: "start" | "update" | "wait" | "end";
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

async function dashboardActivitySourceName(
  client: any,
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

function galleryInteractionKind(style: (typeof liveActivityStyles)[number]): "approval" | "yes_no" | null {
  if (style === "approval" || style === "shell") return "approval";
  if (style === "verdict" || style === "signal") return "yes_no";
  return null;
}

async function createDashboardActivityEvent(
  client: any,
  input: {
    principalId: string; activity: any; operation: "start" | "update" | "end";
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
  if (eligible.rows.length !== input.deviceIds.length) return {
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
       SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
      [event.rows[0].id,input.deviceIds],
    );
    const request = await client.query(
      `INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
       VALUES ($1,$2,$3,$4,$5,now()+interval '10 minutes') RETURNING id,expires_at`,
      [input.principalId,event.rows[0].id,input.interactionKind,input.prompt,hashToken(generateToken())],
    );
    const interaction = {
      id: publicId("int",request.rows[0].id), notificationId: publicId("ntf",event.rows[0].id),
      kind: input.interactionKind, state: "pending", expiresAt: new Date(request.rows[0].expires_at).toISOString(),
    };
    const firstDevice = eligible.rows[0];
    const commonCommand = presentationCommandProjection(presentationFromRow(input.activity));
    const command = {
      operation: input.operation, activityId, targetDeviceId: publicId("dev",firstDevice.id),
      generation: Number(input.activity.generation),
      style: input.activity.style ?? "standard", sourceName: input.sourceName,
      expiresAt: input.activity.expires_at ?? null, staleAt: input.activity.stale_at ?? null,
      alertOwner: "app", sequence: Number(input.activity.sequence),
      dismissAfterSeconds: input.dismissAfterSeconds ?? null, interaction: null,
      ...commonCommand,
    };
    await client.query(
      "UPDATE notification_events SET payload=$2::jsonb WHERE id=$1",
      [event.rows[0].id,{ liveActivity: command, interactionId: interaction.id,
        interactionType: input.interactionKind,
        ...(input.parentActivityId ? { workbench: { parentActivityId: input.parentActivityId } } : {}) }],
    );
    const remote = input.apnsMode === "disabled" ? { rowCount: 0 } : await client.query(
      `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
       SELECT $1,d.id,'live_activity_start',$3 FROM devices d
       WHERE d.id=ANY($2::uuid[]) AND d.principal_id=$4
         AND d.apns_environment=$5::apns_environment
         AND d.live_activity_push_to_start_token IS NOT NULL ON CONFLICT DO NOTHING`,
      [event.rows[0].id,input.deviceIds,input.activity.id,input.principalId,input.apnsMode],
    );
    const eventId = publicId("ntf",event.rows[0].id);
    const delivery = { eligibleDevices: eligible.rows.length, durableCommands: eligible.rows.length,
      apnsJobs: remote.rowCount ?? 0 };
    await client.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",[
      event.rows[0].id,delivery,
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
      [event.rows[0].id,device.id],
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
      [event.rows[0].id,{ liveActivity: command }],
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
        [event.rows[0].id,device.id,
          input.operation === "start" || lease.restartRequired ? "live_activity_start" : "live_activity_update",
          input.activity.id],
      );
      apnsJobs += 1;
    }
    await client.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",[
      event.rows[0].id,{ eligibleDevices: 1, durableCommands: 1, apnsJobs: remoteEligible ? 1 : 0 },
    ]);
    eventIds.push(publicId("ntf",event.rows[0].id));
  }
  return {
    eventId: eventIds[0] ?? null, eventIds, queued: apnsJobs,
    delivery: { eligibleDevices: eligible.rows.length, durableCommands: eventIds.length, apnsJobs },
    interaction: interactions[0] ?? null, interactions,
  };
}

async function createDashboardTextInteraction(
  client: any,
  input: { principalId: string; parentActivityId: string; activity: any; deviceIds: string[]; prompt: string;
    sourceName: string; apnsMode: ApnsMode },
): Promise<{
  eventId: string; queued: number;
  delivery: { eligibleDevices: number; durableCommands: number; apnsJobs: number };
  interaction: Record<string,unknown>;
}> {
  const eligible = await client.query(
    `SELECT id FROM devices WHERE principal_id=$1 AND revoked_at IS NULL
       AND id=ANY($2::uuid[]) AND notification_authorization IN ('authorized','provisional')
       ORDER BY id`,
    [input.principalId,input.deviceIds],
  );
  if (eligible.rows.length !== input.deviceIds.length) throw new Error("activity_target_unavailable");
  const event = await client.query(
    `INSERT INTO notification_events(
       principal_id,source,kind,title,body,payload,idempotency_key,target_mode,expires_at,origin_hash
     ) VALUES ($1,$2,'question',$3,$4,$5,$6,'explicit',now()+interval '10 minutes',$7)
     RETURNING id`,
    [input.principalId,input.sourceName,input.activity.title,input.prompt,
      { interactionType: "text", workbench: { parentActivityId: input.parentActivityId } },
      `dashboard:${randomUUID()}:wait-text`,input.activity.origin_hash ?? null],
  );
  await client.query(
    `INSERT INTO notification_event_targets(notification_event_id,device_id)
     SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [event.rows[0].id,input.deviceIds],
  );
  const request = await client.query(
    `INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
     VALUES ($1,$2,'text',$3,$4,now()+interval '10 minutes') RETURNING id,expires_at`,
    [input.principalId,event.rows[0].id,input.prompt,hashToken(generateToken())],
  );
  const interactionId = publicId("int",request.rows[0].id);
  await client.query(
    "UPDATE notification_events SET payload=payload||$2::jsonb WHERE id=$1",
    [event.rows[0].id,{ interactionId }],
  );
  const jobs = input.apnsMode === "disabled" ? { rowCount: 0 } : await client.query(
    `INSERT INTO delivery_jobs(notification_event_id,device_id)
     SELECT $1,d.id FROM devices d WHERE d.principal_id=$2 AND d.revoked_at IS NULL
       AND d.id=ANY($3::uuid[]) AND d.apns_token IS NOT NULL
       AND d.apns_environment=$4::apns_environment
       AND d.notification_authorization IN ('authorized','provisional')
       ON CONFLICT DO NOTHING`,
    [event.rows[0].id,input.principalId,input.deviceIds,input.apnsMode],
  );
  const delivery = { eligibleDevices: eligible.rows.length, durableCommands: 1, apnsJobs: jobs.rowCount ?? 0 };
  await client.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",[event.rows[0].id,delivery]);
  return {
    eventId: publicId("ntf",event.rows[0].id), queued: delivery.apnsJobs, delivery,
    interaction: { id: interactionId, notificationId: publicId("ntf",event.rows[0].id), kind: "text",
      state: "pending", expiresAt: new Date(request.rows[0].expires_at).toISOString() },
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]!);
}

export function safeNextPath(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    return "/dashboard";
  }
  return value;
}

export function safeDashboardDestination(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function page(title: string, content: string): string {
  return renderDocument(title, content);
}

export async function getOwnerAccount(db: Database, accountAuth: AccountAuth, headers: Headers): Promise<OwnerAccount | null> {
  const session = await getAccountSession(accountAuth, headers);
  if (!session) return null;
  const mapped = await db.query<{ principal_id: string }>(
    `SELECT i.principal_id FROM account_identities i
     JOIN owner_principals p ON p.id=i.principal_id
     WHERE i.provider='better-auth' AND i.subject=$1 AND p.disabled_at IS NULL
       AND i.disabled_at IS NULL`,
    [session.user.id],
  );
  if (!mapped.rowCount) return null;
  const principalId = mapped.rows[0]!.principal_id;
  return { ...session, principalId, accountId: publicId("acc", principalId) };
}

export function registerWebAuthRoutes(app: Hono, db: Database, dependencies: WebAuthDependencies): void {
  const { accountAuth, bootstrapOwnerHandle, appUrl, apnsMode } = dependencies;
  const appOrigin = new URL(appUrl).origin;
  const releaseIdentity = dashboardReleaseIdentity(process.env.RELO_RELEASE_IDENTITY);
  const inboxHandlers = createDashboardInboxHandlers({
    db,
    releaseIdentity,
    getAccount: (headers) => getOwnerAccount(db,accountAuth,headers),
    renderDocument: renderDashboardAppDocument,
    reconcileActivities: dependencies.reconcileActivities ?? (() => expireDueActivities(db,apnsMode)),
    contentCipher: createNotificationContentCipher(
      dependencies.credentialDerivationSecret.length >= 32
        ? dependencies.credentialDerivationSecret
        : apnsMode === "disabled"
          ? "relo-test-notification-content-secret-v1"
          : dependencies.credentialDerivationSecret,
    ),
  });
  const systemHandlers = createDashboardSystemHandlers({
    db,
    releaseIdentity,
    serverOrigin: appOrigin,
    getAccount: (headers) => getOwnerAccount(db,accountAuth,headers),
    renderDocument: renderDashboardAppDocument,
  });
  const activityHistoryHandler = createDashboardActivityHistoryHandler({
    db,
    releaseIdentity,
    getAccount: (headers) => getOwnerAccount(db,accountAuth,headers),
    renderDocument: renderDashboardAppDocument,
  });
  const connectionsHandlers = createDashboardConnectionsHandlers({
    db,
    releaseIdentity,
    getAccount: (headers) => getOwnerAccount(db,accountAuth,headers),
    renderDocument: renderDashboardAppDocument,
  });

  const noStoreDashboard = async (context: any,next: () => Promise<void>) => {
    await next();
    context.header("cache-control","private, no-store");
  };
  app.use("/dashboard",noStoreDashboard);
  app.use("/dashboard/*",noStoreDashboard);

  app.get("/assets/relo-dashboard.css", (context) => {
    context.header("cache-control", "public, max-age=0, must-revalidate");
    return context.body(dashboardStyles, 200, { "content-type": "text/css; charset=utf-8" });
  });
  app.get("/assets/relo-dashboard.js", (context) => {
    context.header("cache-control", "public, max-age=0, must-revalidate");
    return context.body(dashboardScript, 200, { "content-type": "text/javascript; charset=utf-8" });
  });
  app.get("/assets/:dashboardAsset", async (context) => {
    const response = await dashboardAppAssetResponse(context.req.param("dashboardAsset"));
    return response ?? context.notFound();
  });
  app.get("/docs.md", (context) => context.text(documentationMarkdown(),200,{ "content-type": "text/markdown; charset=utf-8" }));
  app.get("/agents.md", (context) => context.text(agentsMarkdown(),200,{ "content-type": "text/markdown; charset=utf-8" }));
  app.get("/llms.txt", (context) => context.text(llmsText(),200,{ "content-type": "text/plain; charset=utf-8" }));

  async function dashboardMutationAccount(context: any): Promise<OwnerAccount | Response> {
    const account = await getOwnerAccount(db, accountAuth, context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" }, 401);
    if (context.req.header("origin") !== appOrigin) return context.json({ error: "forbidden" }, 403);
    return account;
  }

  const projectHandlers = createDashboardProjectHandlers({
    db,
    releaseIdentity,
    getAccount: (headers) => getOwnerAccount(db,accountAuth,headers),
    authorizeMutation: dashboardMutationAccount,
    renderDocument: renderDashboardAppDocument,
  });

  async function accountMutationAccount(context: any): Promise<OwnerAccount | Response> {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    const origin = context.req.header("origin");
    if (origin !== undefined && origin !== appOrigin) return context.json({ error: "forbidden" },403);
    return account;
  }

  app.post("/api/auth/sign-up/email", async (context) => {
    const client = await db.connect();
    let createdUserId: string | undefined;
    const signupStartedAt = new Date();
    const signupPayload = await context.req.raw.clone().json().catch(() => null) as { email?: unknown } | null;
    const signupEmail = typeof signupPayload?.email === "string" ? signupPayload.email : undefined;
    const compensateUnmappedIdentity = async () => {
      await db.query(
        `DELETE FROM auth.users u WHERE NOT EXISTS (
           SELECT 1 FROM account_identities i WHERE i.provider='better-auth' AND i.subject=u.id
         ) AND (
           ($1::text IS NOT NULL AND u.id=$1)
           OR ($2::text IS NOT NULL AND lower(u.email)=lower($2) AND u.created_at >= $3)
         )`,
        [createdUserId ?? null,signupEmail ?? null,signupStartedAt],
      );
    };
    try {
      await client.query("BEGIN");
      await lockAccountLifecycle(client);
      const claimed = await client.query("SELECT 1 FROM account_identities LIMIT 1");
      if (claimed.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "account_already_configured" },403);
      }

      const authResponse = await accountAuth.handler(context.req.raw);
      if (!authResponse.ok) {
        await client.query("ROLLBACK");
        await compensateUnmappedIdentity();
        return authResponse;
      }
      const payload = await authResponse.clone().json() as { user?: { id?: string } };
      if (!payload.user?.id) {
        await client.query("ROLLBACK");
        await compensateUnmappedIdentity();
        return context.json({ error: "account_setup_failed" },500);
      }
      createdUserId = payload.user.id;

      const mapping = await client.query(
        `INSERT INTO account_identities(principal_id,provider,subject)
         SELECT id,'better-auth',$2 FROM owner_principals WHERE handle=$1 AND disabled_at IS NULL
         ON CONFLICT DO NOTHING RETURNING principal_id`,
        [bootstrapOwnerHandle,payload.user.id],
      );
      if (!mapping.rowCount) {
        await client.query("DELETE FROM auth.users WHERE id=$1",[payload.user.id]);
        await client.query("COMMIT");
        return context.json({ error: "owner_not_bootstrapped" },503);
      }
      await client.query("COMMIT");
      return authResponse;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {
        // The separately committed Better Auth identity is compensated through the pool below.
      }
      try {
        await compensateUnmappedIdentity();
      } catch (cleanupError) {
        throw new AggregateError([error,cleanupError],"Owner signup and orphan-identity compensation both failed");
      }
      throw error;
    } finally { client.release(); }
  });

  app.post("/api/auth/sign-in/email", async (context) => {
    const input = await context.req.raw.clone().json().catch(() => null) as { rememberMe?: unknown } | null;
    if (!input || input.rememberMe !== true) return context.json({ error: "invalid_request" }, 400);
    return accountAuth.handler(context.req.raw);
  });

  app.get("/api/auth/get-session", async (context) => {
    const response = await accountAuth.handler(context.req.raw);
    if (!response.ok) return response;
    const payload = await response.clone().json().catch(() => null);
    return payload ? response : context.json({ error: "reauthentication_required" }, 401);
  });

  app.get("/api/account/deliveries/status", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    context.header("cache-control", "private, no-store");
    return context.json({ apns: apnsTransportTruth(apnsMode) });
  });

  app.put("/api/dashboard/account/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const policy = liveActivityPresentationPolicySchema.parse(await context.req.json());
    await db.query(
      "UPDATE owner_principals SET live_activity_policy=$2::jsonb WHERE id=$1 AND disabled_at IS NULL",
      [account.principalId,policy],
    );
    return context.json({ policy,source: "account" });
  });

  app.delete("/api/dashboard/account/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    await db.query(
      "UPDATE owner_principals SET live_activity_policy=NULL WHERE id=$1 AND disabled_at IS NULL",
      [account.principalId],
    );
    return context.json({
      reset: true,
      policy: SYSTEM_PRESENTATION_POLICY,
      source: "system",
    });
  });

  app.post("/api/dashboard/connection-grants", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const issued = await createConnectionGrant({
      db,
      principalId: account.principalId,
      userId: account.user.id,
      origin: appOrigin,
    });
    const encoded = JSON.stringify(issued.document);
    const qrDataUrl = await QRCode.toDataURL(encoded, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 640,
      color: { dark: "#07111fff", light: "#ffffffff" },
    });
    context.header("cache-control","private, no-store");
    return context.json({
      id: publicId("pair",issued.id),
      origin: issued.document.origin,
      expiresAt: issued.document.expiresAt,
      qrDataUrl,
    },201);
  });

  async function ownerAdminAccount(context: any): Promise<OwnerAccount | Response> {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    if (!await assertOwnerRole(db,account.principalId,account.user.id)) {
      return context.json({ error: "owner_role_required" },403);
    }
    return account;
  }

  app.post("/api/dashboard/users", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().email().max(320),
      password: z.string().min(8).max(128),
    }).strict().parse(await context.req.json());
    const user = await createAccountUser({ db,principalId: account.principalId,...input });
    return context.json({ id: user.id },201);
  });

  app.post("/api/dashboard/users/:userId/reset-password", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({ password: z.string().min(8).max(128) }).strict().parse(await context.req.json());
    await resetAccountUserPassword({ db,principalId: account.principalId,
      subject: context.req.param("userId"),password: input.password });
    return context.json({ ok: true });
  });

  app.post("/api/dashboard/users/:userId/:action", async (context) => {
    const account = await ownerAdminAccount(context);
    if (account instanceof Response) return account;
    const action = z.enum(["disable","enable","revoke-sessions"]).parse(context.req.param("action"));
    const subject = context.req.param("userId");
    if (action === "revoke-sessions") {
      await db.query(`DELETE FROM auth.sessions s USING account_identities i
        WHERE s.user_id=i.subject AND i.principal_id=$1 AND i.subject=$2`,[account.principalId,subject]);
    } else {
      await db.query(`UPDATE account_identities SET disabled_at=${action === "disable" ? "now()" : "NULL"}
        WHERE principal_id=$1 AND subject=$2 AND role<>'owner'`,[account.principalId,subject]);
      if (action === "disable") await db.query("DELETE FROM auth.sessions WHERE user_id=$1",[subject]);
    }
    if (action === "disable" || action === "revoke-sessions") {
      await db.query(`UPDATE device_credentials c SET revoked_at=now()
        FROM devices d WHERE c.device_id=d.id AND d.principal_id=$1
          AND d.registered_by_subject=$2 AND c.revoked_at IS NULL`,[account.principalId,subject]);
      await db.query(`UPDATE devices SET revoked_at=now() WHERE principal_id=$1
        AND registered_by_subject=$2 AND revoked_at IS NULL`,[account.principalId,subject]);
    }
    return context.json({ ok: true });
  });

  app.post("/api/account/delete", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({
      password: z.string().min(8).max(128),
      confirmation: z.literal("DELETE"),
    }).strict().parse(await context.req.json());
    try {
      await accountAuth.api.verifyPassword({
        body: { password: input.password },
        headers: context.req.raw.headers,
      });
    } catch {
      return context.json({ error: "invalid_password" },401);
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockAccountLifecycle(client);
      const locked = await client.query<{ principal_id: string }>(
        `SELECT principal_id FROM account_identities
         WHERE provider='better-auth' AND subject=$1 AND principal_id=$2 FOR UPDATE`,
        [account.user.id,account.principalId],
      );
      if (!locked.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "account_not_found" },404);
      }
      await client.query(
        `DELETE FROM request_rate_limits WHERE
          (scope_kind='account' AND scope_id=$1)
          OR (scope_kind='client' AND scope_id IN (SELECT id FROM principal_api_keys WHERE principal_id=$1))
          OR (scope_kind='device' AND scope_id IN (SELECT id FROM devices WHERE principal_id=$1))
          OR (scope_kind='service' AND scope_id IN (SELECT id FROM webhook_services WHERE principal_id=$1))`,
        [account.principalId],
      );
      await client.query("DELETE FROM device_authorizations WHERE approved_owner_id=$1 OR approved_owner_id IS NULL",[account.principalId]);
      await client.query("DELETE FROM auth.verifications");
      await client.query("DELETE FROM auth.users WHERE id=$1",[account.user.id]);
      await client.query("DELETE FROM owner_principals WHERE id=$1",[account.principalId]);
      await client.query(
        `INSERT INTO owner_principals(handle) VALUES ($1)
         ON CONFLICT (handle) DO UPDATE SET disabled_at=NULL RETURNING id`,
        [bootstrapOwnerHandle],
      );
      await client.query("COMMIT");
      return context.json({ ok: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.on(["GET", "POST"], "/api/auth/*", (context) => accountAuth.handler(context.req.raw));

  app.post("/api/dashboard/services", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const input = z.object({
      title: z.string().trim().min(1).max(80),
      imageUrl: publicHttpsUrlSchema.nullable().optional(),
      destinationUrl: httpsUrlSchema.nullable().optional(),
    }).strict().parse(await context.req.json());
    const defaults = {
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
      ...(input.destinationUrl !== undefined ? { destinationUrl: input.destinationUrl } : {}),
    };
    const created = await createWebhookService(db, account.principalId, input.title, appUrl, defaults);
    const policyResult = await db.query<{ live_activity_policy: unknown }>(
      "SELECT live_activity_policy FROM owner_principals WHERE id=$1",
      [account.principalId],
    );
    const accountPolicy = parsePresentationPolicy(policyResult.rows[0]?.live_activity_policy);
    return context.json({
      service: {
        id: publicId("svc",created.row.id),
        title: created.row.title,
        prefix: created.row.secret_prefix,
        liveActivityPolicy: null,
        effectiveLiveActivityPolicy: accountPolicy ?? SYSTEM_PRESENTATION_POLICY,
        liveActivityPolicySource: accountPolicy ? "account" : "system",
      },
      webhookUrl: created.webhookUrl,
    }, 201);
  });

  app.patch("/api/dashboard/services/:serviceId", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const serviceId = internalId("svc",context.req.param("serviceId"));
    if (!serviceId) return context.json({ error: "not_found" }, 404);
    const input = z.object({
      title: z.string().trim().min(1).max(80),
      imageUrl: publicHttpsUrlSchema.nullable(),
      destinationUrl: httpsUrlSchema.nullable(),
    }).strict().parse(await context.req.json());
    const result = await db.query<any>(
      `UPDATE webhook_services SET title=$3,image_url=$4,default_url=$5,updated_at=now()
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id,title,secret_prefix,image_url,default_url`,
      [serviceId,account.principalId,input.title,input.imageUrl,input.destinationUrl],
    );
    return result.rowCount
      ? context.json({ service: {
        id: publicId("svc",result.rows[0].id), title: result.rows[0].title,
        prefix: result.rows[0].secret_prefix, imageUrl: result.rows[0].image_url,
        destinationUrl: result.rows[0].default_url,
      } })
      : context.json({ error: "not_found" },404);
  });

  app.post("/api/dashboard/services/:serviceId/rotate", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const serviceId = internalId("svc",context.req.param("serviceId"));
    if (!serviceId) return context.json({ error: "not_found" }, 404);
    const rotated = await rotateWebhookService(db, account.principalId, serviceId, appUrl);
    if (!rotated) return context.json({ error: "not_found" }, 404);
    return context.json({
      service: { id: publicId("svc",rotated.row.id), title: rotated.row.title, prefix: rotated.row.secret_prefix },
      webhookUrl: rotated.webhookUrl,
    });
  });

  app.delete("/api/dashboard/services/:serviceId", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const serviceId = internalId("svc",context.req.param("serviceId"));
    if (!serviceId) return context.json({ error: "not_found" }, 404);
    const result = await db.query("UPDATE webhook_services SET revoked_at=COALESCE(revoked_at,now()),updated_at=now() WHERE id=$1 AND principal_id=$2 RETURNING id", [serviceId,account.principalId]);
    return result.rowCount ? context.json({ revoked: true }) : context.json({ error: "not_found" }, 404);
  });

  app.put("/api/dashboard/services/:serviceId/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const serviceId = internalId("svc",context.req.param("serviceId"));
    if (!serviceId) return context.json({ error: "not_found" },404);
    const policy = liveActivityPresentationPolicySchema.parse(await context.req.json());
    const result = await db.query(
      `UPDATE webhook_services SET live_activity_policy=$3::jsonb,updated_at=now()
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
      [serviceId,account.principalId,policy],
    );
    return result.rowCount
      ? context.json({ policy,source: "service" })
      : context.json({ error: "not_found" },404);
  });

  app.delete("/api/dashboard/services/:serviceId/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const serviceId = internalId("svc",context.req.param("serviceId"));
    if (!serviceId) return context.json({ error: "not_found" },404);
    const result = await db.query(
      `UPDATE webhook_services SET live_activity_policy=NULL,updated_at=now()
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
      [serviceId,account.principalId],
    );
    if (!result.rowCount) return context.json({ error: "not_found" },404);
    const inherited = await db.query<{ live_activity_policy: unknown }>(
      "SELECT live_activity_policy FROM owner_principals WHERE id=$1",
      [account.principalId],
    );
    const accountPolicy = parsePresentationPolicy(inherited.rows[0]?.live_activity_policy);
    return context.json({
      reset: true,
      policy: accountPolicy ?? SYSTEM_PRESENTATION_POLICY,
      source: accountPolicy ? "account" : "system",
    });
  });

  app.post("/api/dashboard/devices/:deviceId/revoke", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const deviceId = internalId("dev",context.req.param("deviceId"));
    if (!deviceId) return context.json({ error: "not_found" }, 404);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE devices SET revoked_at=COALESCE(revoked_at,now()),apns_token=NULL,
           live_activity_push_to_start_token=NULL,
           credential_version=credential_version+CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END
         WHERE id=$1 AND principal_id=$2 RETURNING id`,
        [deviceId,account.principalId],
      );
      if (!result.rowCount) { await client.query("ROLLBACK"); return context.json({ error: "not_found" }, 404); }
      await client.query("UPDATE device_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE device_id=$1", [deviceId]);
      await client.query("UPDATE delivery_jobs SET state='canceled',updated_at=now() WHERE device_id=$1 AND state IN ('pending','retry')", [deviceId]);
      await client.query("COMMIT");
      return context.json({ revoked: true });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  });

  app.post("/api/dashboard/credentials/:credentialId/revoke", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const credentialId = internalId("key",context.req.param("credentialId"));
    if (!credentialId) return context.json({ error: "not_found" }, 404);
    const result = await db.query("UPDATE principal_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND principal_id=$2 RETURNING id", [credentialId,account.principalId]);
    return result.rowCount ? context.json({ revoked: true }) : context.json({ error: "not_found" }, 404);
  });

  app.put("/api/dashboard/credentials/:credentialId/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const credentialId = internalId("key",context.req.param("credentialId"));
    if (!credentialId) return context.json({ error: "not_found" },404);
    const policy = liveActivityPresentationPolicySchema.parse(await context.req.json());
    const result = await db.query(
      `UPDATE principal_api_keys SET live_activity_policy=$3::jsonb
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
      [credentialId,account.principalId,policy],
    );
    return result.rowCount
      ? context.json({ policy,source: "client" })
      : context.json({ error: "not_found" },404);
  });

  app.delete("/api/dashboard/credentials/:credentialId/live-activity-policy", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const credentialId = internalId("key",context.req.param("credentialId"));
    if (!credentialId) return context.json({ error: "not_found" },404);
    const result = await db.query(
      `UPDATE principal_api_keys SET live_activity_policy=NULL
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
      [credentialId,account.principalId],
    );
    if (!result.rowCount) return context.json({ error: "not_found" },404);
    const inherited = await db.query<{ live_activity_policy: unknown }>(
      "SELECT live_activity_policy FROM owner_principals WHERE id=$1",
      [account.principalId],
    );
    const accountPolicy = parsePresentationPolicy(inherited.rows[0]?.live_activity_policy);
    return context.json({
      reset: true,
      policy: accountPolicy ?? SYSTEM_PRESENTATION_POLICY,
      source: accountPolicy ? "account" : "system",
    });
  });

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
    const testId = randomUUID();
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const device = await client.query<any>(
        `SELECT id,name,apns_token,apns_environment,notification_authorization,live_activity_authorization,
           live_activity_push_to_start_token
         FROM devices WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL FOR UPDATE`,
        [deviceId,account.principalId],
      );
      if (!device.rowCount) {
        await transaction.rollback();
        return context.json({ error: "device_not_found" }, 404);
      }
      if (device.rows[0].live_activity_authorization !== "authorized") {
        await transaction.rollback();
        return context.json({ error: "live_activities_not_authorized" }, 409);
      }
      if (!["authorized", "provisional"].includes(device.rows[0].notification_authorization)) {
        await transaction.rollback();
        return context.json({ error: "notifications_not_authorized" }, 409);
      }
      const originHash = dashboardTestLabOrigin(account.principalId,deviceId);
      const originSlot = await lockOriginGenerationSlot(client,account.principalId,originHash);
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
        return context.json({ error: "active_origin_conflict",code: "ACTIVE_ORIGIN_CONFLICT" },409);
      }
      const activeSlot = {
        rows: originSlot.active ? [originSlot.active] : [],
        rowCount: originSlot.active ? 1 : 0,
      };
      const operation: "start" | "update" = activeSlot.rowCount ? "update" : "start";
      const apnsOwnsStartAlert = dependencies.apnsMode !== "disabled"
        && device.rows[0].apns_environment === dependencies.apnsMode
        && Boolean(device.rows[0].live_activity_push_to_start_token);
      const generation = operation === "update"
        ? Number(activeSlot.rows[0].generation)
        : originSlot.nextGeneration;
      const activity = operation === "update" ? await client.query<any>(
        `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
           accent_color=$9,privacy=$10,presentation=$11,presentation_sha256=$12,
           expires_at=LEAST(now()+($13*interval '1 second'),created_at+($14*interval '1 second')),
           stale_at=LEAST(now()+($15*interval '1 second'),created_at+($14*interval '1 second')),
           sequence=sequence+1,updated_at=now()
         WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
        [activeSlot.rows[0].id,account.principalId,configuration.title,configuration.status,
          configuration.detail,configuration.progress,configuration.symbol,configuration.style,
          configuration.accentColor,configuration.privacyMode,configuration.stored.presentation,
          configuration.stored.presentationHash,dashboardTestIdleTimeoutSeconds,
          dashboardTestHardTimeoutSeconds,dashboardTestStaleAfterSeconds],
      ) : await client.query<any>(
        `INSERT INTO live_activities(
           principal_id,activity_key,title,status,detail,progress,symbol,style,accent_color,privacy,
           target_device_ids,start_idempotency_key,presentation,presentation_sha256,expires_at,stale_at,origin_hash,generation,
           presentation_policy,presentation_policy_source,presentation_preset_id,presentation_preset_revision
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,ARRAY[$11::uuid],$12,$13,$14,
           now()+($15*interval '1 second'),now()+($16*interval '1 second'),$17,$18,$19::jsonb,'system',$20,1) RETURNING *`,
        [account.principalId,`dashboard-test-${testId}`,configuration.title,configuration.status,
          configuration.detail,configuration.progress,configuration.symbol,configuration.style,configuration.accentColor,
          configuration.privacyMode,deviceId,`dashboard:${testId}:activity`,configuration.stored.presentation,
          configuration.stored.presentationHash,dashboardTestIdleTimeoutSeconds,dashboardTestStaleAfterSeconds,
          originHash,generation,systemPresentationPolicySnapshot("system.dashboard.test"),"system.dashboard.test"],
      );
      if (operation === "update") {
        await recordActivityCorrelationDecision(client,{
          principalId: account.principalId,
          activityId: activity.rows[0].id,
          outcome: "reused",
          matchedBy: "origin",
          actor: "dashboard",
          reason: "active_origin_match",
        });
      } else {
        await recordActivityStartEvidence(client,{
          principalId: account.principalId,
          activityId: activity.rows[0].id,
          actor: "dashboard",
          previousActivityId: originSlot.latest?.id ?? null,
          matchedBy: originSlot.latest ? "origin" : "none",
          reason: originSlot.latest ? "same_origin_generation" : "new_activity_created",
        });
      }
      const activityId = publicId("act",activity.rows[0].id);
      const event = await client.query<any>(
         `INSERT INTO notification_events(
           principal_id,source,kind,title,body,payload,idempotency_key,target_mode,expires_at,origin_hash
         ) VALUES ($1,$2,'live_activity',$3,$4,$5,$6,'explicit',$7,$8) RETURNING id,created_at`,
        [account.principalId,configuration.sourceName,configuration.title,configuration.detail ?? "",{},
          `dashboard:${testId}:event`,activity.rows[0].expires_at,originHash],
      );
      await client.query(
        `INSERT INTO notification_event_targets(notification_event_id,device_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [event.rows[0].id,deviceId],
      );
      await cancelPendingActivityInteractions(client,account.principalId,activity.rows[0].id);
      const interactionKind = configuration.interactionKind === "text" ? null : configuration.interactionKind;
      let interactionCommand: Record<string,unknown> | null = null;
      if (interactionKind) {
        const interaction = await client.query<{ id: string; expires_at: Date }>(
          `INSERT INTO interaction_requests(
             principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at
           ) VALUES ($1,$2,$3,$4,$5,now()+interval '10 minutes') RETURNING id,expires_at`,
          [account.principalId,event.rows[0].id,interactionKind,configuration.detail ?? configuration.title,
            hashToken(generateToken())],
        );
        const row = interaction.rows[0]!;
        interactionCommand = {
          id: publicId("int",row.id), notificationId: publicId("ntf",event.rows[0].id),
          kind: interactionKind, state: "pending", expiresAt: row.expires_at.toISOString(),
        };
      }
      const presentationLease = await syncActivityPresentationLease(client,{
        principalId: account.principalId,
        activity: activity.rows[0],
        deviceId,
        operation,
      });
      const presentationCommand = presentationCommandProjection(activity.rows[0].presentation);
      const liveActivity = {
        operation, activityId, generation: Number(activity.rows[0].generation),
        priority: 10,
        targetDeviceId: input.deviceId, style: configuration.style,
        ...presentationCommand,
        sourceName: configuration.sourceName, sequence: Number(activity.rows[0].sequence),
        expiresAt: activity.rows[0].expires_at ?? null, staleAt: activity.rows[0].stale_at ?? null,
        alertOwner: operation === "start" || presentationLease.restartRequired
          ? (apnsOwnsStartAlert ? "apns" : "app") : "none",
        dismissAfterSeconds: null, interaction: null,
        relevanceScore: presentationLease.relevanceScore,
        presentationState: presentationLease.state,
        otherActiveCount: presentationLease.otherActiveCount,
      };
      await client.query(
        "UPDATE notification_events SET payload=$2::jsonb WHERE id=$1",
        [event.rows[0].id,{ liveActivity,
          ...(interactionCommand ? { interactionId: interactionCommand.id, interactionType: interactionKind } : {}) }],
      );
      const jobs = dependencies.apnsMode !== "disabled" && device.rows[0].apns_environment === dependencies.apnsMode
        ? await client.query(
        `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [event.rows[0].id,deviceId,
          operation === "start" || presentationLease.restartRequired
            ? "live_activity_start" : "live_activity_update",
          activity.rows[0].id],
      ) : { rowCount: 0 };
      const delivery = { eligibleDevices: 1, durableCommands: 1, apnsJobs: jobs.rowCount ?? 0 };
      await client.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",[
        event.rows[0].id,delivery,
      ]);
      await recordDashboardActivityOperation(client,{
        principalId: account.principalId, activity: activity.rows[0], operation,
        delivery, request: input,
      });
      const textCompanion = configuration.interactionKind === "text"
        ? await createDashboardTextInteraction(client,{
          principalId: account.principalId, parentActivityId: activityId, activity: activity.rows[0],
          deviceIds: [deviceId], prompt: configuration.detail ?? configuration.title,
          sourceName: configuration.sourceName, apnsMode: dependencies.apnsMode,
        })
        : null;
      await transaction.commit();
      return context.json({
        activity: { id: activityId, style: configuration.style, title: configuration.title,
          operation, generation: Number(activity.rows[0].generation),
          sequence: Number(activity.rows[0].sequence),
          presentationHash: configuration.stored.presentationHash,ownerKind: "dashboard_test" },
        presentation: configuration.presentation,
        transportMode: "current",
        eventId: publicId("ntf",event.rows[0].id),
        companionEventId: textCompanion?.eventId ?? null,
        interaction: interactionCommand ?? textCompanion?.interaction ?? null,
        device: { id: input.deviceId, name: device.rows[0].name },
        queued: jobs.rowCount ?? 0,
        delivery,
        ...originGenerationMetadata(activity.rows[0],operation === "update"),
        disposition: operation === "update" ? "reused" : "created",
        replaced,
        replacedEventIds,
        instruction: "Open Relo on this iPhone and tap Refresh to render the preview.",
      }, operation === "start" ? 201 : 200);
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally { await transaction.close(); }
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
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const activity = await client.query<any>(
        `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
           privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
           expires_at=LEAST(now()+($13*interval '1 second'),created_at+($14*interval '1 second')),
           stale_at=LEAST(now()+($15*interval '1 second'),created_at+($14*interval '1 second')),
           sequence=sequence+1,updated_at=now()
         WHERE id=$1 AND principal_id=$2 AND state='active' AND expires_at>now()
           AND requester_service_id IS NULL AND requester_credential_id IS NULL RETURNING *`,
        [activityId,account.principalId,stored.title,stored.status,stored.detail,stored.progress,
          stored.symbol,stored.style,stored.privacy,stored.accentColor,stored.presentation,stored.presentationHash,
          dashboardTestIdleTimeoutSeconds,dashboardTestHardTimeoutSeconds,dashboardTestStaleAfterSeconds],
      );
      if (!activity.rowCount || !activity.rows[0].target_device_ids?.length) {
        await transaction.rollback();
        return context.json({ error: "activity_not_active" },409);
      }
      await cancelPendingActivityInteractions(client,account.principalId,activityId);
      const sourceName = await dashboardActivitySourceName(client,account.principalId,activityId);
      const command = await createDashboardActivityEvent(client,{
        principalId: account.principalId, activity: activity.rows[0], operation: "update",
        deviceIds: activity.rows[0].target_device_ids, sourceName,
        apnsMode: dependencies.apnsMode,
      });
      if (!command.delivery.durableCommands) {
        await transaction.rollback();
        return context.json({ error: "activity_target_unavailable" },409);
      }
      await recordDashboardActivityOperation(client,{
        principalId: account.principalId, activity: activity.rows[0], operation: "update",
        delivery: command.delivery, request: input,
      });
      await transaction.commit();
      return context.json({ activity: serializeTaskActivity(activity.rows[0]), ...command });
    } catch (error) {
      await transaction.rollback(); throw error;
    } finally { await transaction.close(); }
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
        apnsMode: dependencies.apnsMode,
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
        `SELECT * FROM live_activities WHERE id=$1 AND principal_id=$2 AND state='active'
           AND requester_service_id IS NULL AND requester_credential_id IS NULL FOR UPDATE`,
        [activityId,account.principalId],
      );
      if (!parent.rowCount || !parent.rows[0].target_device_ids?.length) {
        await transaction.rollback();
        return context.json({ error: "activity_not_active" },409);
      }
      const sourceName = await dashboardActivitySourceName(client,account.principalId,activityId);
      if (input.kind === "text") {
        const command = await createDashboardTextInteraction(client,{
          principalId: account.principalId, parentActivityId: publicId("act",activityId),
          activity: parent.rows[0], deviceIds: parent.rows[0].target_device_ids, prompt: input.prompt,
          sourceName, apnsMode: dependencies.apnsMode,
        });
        await recordDashboardActivityOperation(client,{
          principalId: account.principalId, activity: parent.rows[0], operation: "wait",
          delivery: command.delivery, request: input,
        });
        await transaction.commit();
        return context.json({ activity: {
          id: publicId("act",activityId), parentActivityId: publicId("act",activityId),
          title: parent.rows[0].title, style: parent.rows[0].style,
          state: parent.rows[0].state, status: parent.rows[0].status,
          progress: parent.rows[0].progress, sequence: Number(parent.rows[0].sequence),
        }, ...command });
      }
      const companionId = randomUUID();
      const companionBase = dashboardBuilderPresetPresentation(
        input.kind === "approval" ? "approval" : "verdict",
      );
      const companionPresentation = persistedPresentationColumns(canonicalPresentation({
        ...companionBase,
        content: {
          header: sourceName,title: parent.rows[0].title,
          status: "Waiting for input",subtitle: input.prompt,
        },
      }));
      const activity = await client.query<any>(
        `INSERT INTO live_activities(
           principal_id,activity_key,title,status,detail,progress,symbol,style,privacy,accent_color,
           target_device_ids,start_idempotency_key,expires_at,stale_at,presentation,presentation_sha256,
           presentation_policy,presentation_policy_source,presentation_preset_id,presentation_preset_revision
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
           now()+interval '10 minutes',now()+interval '10 minutes',$13,$14,$15::jsonb,'system',$16,1) RETURNING *`,
        [account.principalId,`dashboard-wait-${companionId}`,companionPresentation.title,
          companionPresentation.status,companionPresentation.detail,companionPresentation.progress,
          companionPresentation.symbol,companionPresentation.style,companionPresentation.privacy,
          companionPresentation.accentColor,parent.rows[0].target_device_ids,
          `dashboard:${companionId}:activity`,companionPresentation.presentation,
          companionPresentation.presentationHash,
          systemPresentationPolicySnapshot(`system.interactive.${input.kind}`),
          `system.interactive.${input.kind}`],
      );
      const command = await createDashboardActivityEvent(client,{
        principalId: account.principalId, activity: activity.rows[0], operation: "start",
        deviceIds: activity.rows[0].target_device_ids, sourceName,
        interactionKind: input.kind, prompt: input.prompt, apnsMode: dependencies.apnsMode,
        parentActivityId: publicId("act",activityId),
        originHash: parent.rows[0].origin_hash ?? null,
      });
      if (!command.delivery.durableCommands) {
        await transaction.rollback();
        return context.json({ error: "activity_target_unavailable" },409);
      }
      await recordDashboardActivityOperation(client,{
        principalId: account.principalId, activity: parent.rows[0], operation: "wait",
        delivery: command.delivery, request: input, companionActivityId: activity.rows[0].id,
      });
      await recordActivityStartEvidence(client,{
        principalId: account.principalId,
        activityId: activity.rows[0].id,
        actor: "dashboard",
        parentActivityId: activityId,
        matchedBy: "parent",
        reason: "interactive_companion",
      });
      await transaction.commit();
      return context.json({ activity: {
        id: publicId("act",activity.rows[0].id), parentActivityId: publicId("act",activityId),
        title: activity.rows[0].title, style: activity.rows[0].style,
        state: "active", status: activity.rows[0].status,
        progress: activity.rows[0].progress, sequence: Number(activity.rows[0].sequence),
      }, ...command });
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
        const terminal = persistedPresentationColumns(
          dashboardTerminalPresentation(current),
        );
        const activity = await client.query<any>(
          `UPDATE live_activities SET state='ended',title=$3,status=$4,detail=$5,progress=$6,
             symbol=$7,style=$8,privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
             sequence=sequence+1,ended_at=now(),updated_at=now()
           WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
          [current.id,account.principalId,terminal.title,terminal.status,terminal.detail,terminal.progress,
            terminal.symbol,terminal.style,terminal.privacy,terminal.accentColor,terminal.presentation,
            terminal.presentationHash],
        );
        if (!activity.rowCount || !activity.rows[0].target_device_ids?.length) continue;
        await cancelPendingActivityInteractions(client,account.principalId,current.id);
        const sourceName = await dashboardActivitySourceName(client,account.principalId,current.id);
        const command = await createDashboardActivityEvent(client,{
          principalId: account.principalId, activity: activity.rows[0], operation: "end",
          deviceIds: activity.rows[0].target_device_ids, sourceName,
          dismissAfterSeconds: input.dismissAfterSeconds, apnsMode: dependencies.apnsMode,
        });
        if (!command.delivery.durableCommands) {
          await transaction.rollback();
          return context.json({ error: "activity_target_unavailable" },409);
        }
        await recordDashboardActivityOperation(client,{
          principalId: account.principalId, activity: activity.rows[0], operation: "end",
          delivery: command.delivery, request: input, dismissAfterSeconds: input.dismissAfterSeconds,
        });
        ended.push({ id: publicId("act",current.id), sequence: Number(activity.rows[0].sequence) });
        eventIds.push(...command.eventIds);
        delivery.eligibleDevices += command.delivery.eligibleDevices;
        delivery.durableCommands += command.delivery.durableCommands;
        delivery.apnsJobs += command.delivery.apnsJobs;
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
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const current = await client.query<any>(
        `SELECT * FROM live_activities
         WHERE id=$1 AND principal_id=$2 AND state='active'
           AND requester_service_id IS NULL AND requester_credential_id IS NULL
           FOR UPDATE`,
        [activityId,account.principalId],
      );
      if (!current.rowCount || !current.rows[0].target_device_ids?.length) {
        await transaction.rollback();
        return context.json({ error: "activity_not_active" },409);
      }
      const terminal = persistedPresentationColumns(
        dashboardTerminalPresentation(current.rows[0]),
      );
      const activity = await client.query<any>(
        `UPDATE live_activities SET state='ended',title=$3,status=$4,detail=$5,progress=$6,
           symbol=$7,style=$8,privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
           sequence=sequence+1,ended_at=now(),updated_at=now()
         WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
        [activityId,account.principalId,terminal.title,terminal.status,terminal.detail,terminal.progress,
          terminal.symbol,terminal.style,terminal.privacy,terminal.accentColor,terminal.presentation,
          terminal.presentationHash],
      );
      await cancelPendingActivityInteractions(client,account.principalId,activityId);
      const sourceName = await dashboardActivitySourceName(client,account.principalId,activityId);
      const command = await createDashboardActivityEvent(client,{
        principalId: account.principalId, activity: activity.rows[0], operation: "end",
        deviceIds: activity.rows[0].target_device_ids, sourceName,
        dismissAfterSeconds: input.dismissAfterSeconds, apnsMode: dependencies.apnsMode,
      });
      if (!command.delivery.durableCommands) {
        await transaction.rollback();
        return context.json({ error: "activity_target_unavailable" },409);
      }
      await recordDashboardActivityOperation(client,{
        principalId: account.principalId, activity: activity.rows[0], operation: "end",
        delivery: command.delivery, request: input, dismissAfterSeconds: input.dismissAfterSeconds,
      });
      await transaction.commit();
      return context.json({ activity: serializeTaskActivity(activity.rows[0]), ...command });
    } catch (error) {
      await transaction.rollback(); throw error;
    } finally { await transaction.close(); }
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
         delivery.last_error_message AS delivery_error_message
       FROM live_activities a
       LEFT JOIN LATERAL (
         SELECT r.id AS interaction_id,e.id AS event_id,r.kind,r.prompt,r.state,r.response,
           r.expires_at,r.responded_at,i.kind AS action,d.id AS device_id,d.name AS device_name
         FROM interaction_requests r
         JOIN notification_events e ON e.id=r.notification_event_id
         LEFT JOIN interactions i ON i.interaction_request_id=r.id
         LEFT JOIN devices d ON d.id=i.device_id
         WHERE e.principal_id=a.principal_id AND (
           e.payload#>>'{liveActivity,activityId}'=$3 OR e.payload#>>'{workbench,parentActivityId}'=$3)
         ORDER BY r.created_at DESC,i.created_at DESC LIMIT 1
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
    }});
  });

  app.post("/api/dashboard/deliveries/:deliveryId/reconcile", async (context) => {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    const deliveryJobId = internalId("job",context.req.param("deliveryId") ?? "");
    if (!deliveryJobId) return context.json({ error: "delivery_not_found" },404);
    const parsed = z.object({ action: z.enum(deliveryReconciliationActions) }).strict()
      .safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid_reconciliation_action" },400);
    try {
      return context.json(await reconcileDeliveryJob(db,{
        principalId: account.principalId,deliveryJobId,action: parsed.data.action,
        actor: { kind: "dashboard" },
      }));
    } catch (error) {
      if (error instanceof DeliveryReconciliationError) {
        return context.json({ error: error.code },error.status);
      }
      throw error;
    }
  });

  app.get("/api/dashboard/snapshot", async (context) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    const params = new URL(context.req.url).searchParams;
    const requestedIds = (name: string,prefix: "dev" | "key") => {
      const values = params.getAll(name);
      if (values.length > 50) return null;
      const ids = values.map((value) => internalId(prefix,value));
      return ids.some((value) => !value) ? null : ids as string[];
    };
    const deviceIds = requestedIds("deviceId","dev");
    const clientIds = requestedIds("clientId","key");
    if (!deviceIds || !clientIds) return context.json({ error: "invalid_snapshot_selection" },400);
    const [counts,devices,clients] = await Promise.all([
      db.query<any>(`SELECT
        (SELECT count(*)::int FROM notification_events WHERE principal_id=$1) AS notifications,
        (SELECT count(*)::int FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
          WHERE e.principal_id=$1) AS deliveries,
        (SELECT count(*)::int FROM device_authorizations WHERE status='pending' AND expires_at>now()) AS approvals,
        (SELECT count(*)::int FROM devices WHERE principal_id=$1 AND revoked_at IS NULL) AS devices`,
      [account.principalId]),
      deviceIds.length ? db.query<any>(
        `SELECT id,last_seen_at FROM devices WHERE principal_id=$1 AND revoked_at IS NULL AND id=ANY($2::uuid[])`,
        [account.principalId,deviceIds],
      ) : Promise.resolve({ rows: [] }),
      clientIds.length ? db.query<any>(
        `SELECT id,last_used_at FROM principal_api_keys WHERE principal_id=$1 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at>now()) AND id=ANY($2::uuid[])`,
        [account.principalId,clientIds],
      ) : Promise.resolve({ rows: [] }),
    ]);
    context.header("cache-control","private, no-store");
    return context.json({
      revision: Date.now(), counts: counts.rows[0] ?? { notifications: 0,deliveries: 0,approvals: 0,devices: 0 },
      devices: devices.rows.map((row: any) => ({ id: publicId("dev",row.id),lastSeenAt: row.last_seen_at })),
      clients: clients.rows.map((row: any) => ({ id: publicId("key",row.id),lastUsedAt: row.last_used_at })),
    });
  });

  app.post("/api/dashboard/notifications/:notificationId/read", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const notificationId = internalId("ntf",context.req.param("notificationId") ?? "");
    if (!notificationId) return context.json({ error: "notification_not_found" },404);
    const result = await db.query<any>(
      `WITH target AS (
         SELECT id,read_at FROM notification_events WHERE id=$1 AND principal_id=$2
       ), updated AS (
         UPDATE notification_events SET read_at=now(),updated_at=updated_at
         WHERE id IN (SELECT id FROM target) AND read_at IS NULL RETURNING read_at
       )
       SELECT EXISTS(SELECT 1 FROM target) AS found,EXISTS(SELECT 1 FROM updated) AS changed,
         COALESCE((SELECT read_at FROM updated),(SELECT read_at FROM target)) AS read_at`,
      [notificationId,account.principalId],
    );
    if (!result.rows[0]?.found) return context.json({ error: "notification_not_found" },404);
    return context.json({ changed: Boolean(result.rows[0].changed),readAt: result.rows[0].read_at });
  });

  app.post("/api/dashboard/inbox/read", async (context) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const result = await db.query<any>(
      `WITH watermark AS (
         SELECT created_at,id FROM notification_events WHERE principal_id=$1
         ORDER BY created_at DESC,id DESC LIMIT 1
       ), updated AS (
         UPDATE notification_events SET read_at=now(),updated_at=updated_at
         WHERE principal_id=$1 AND read_at IS NULL AND withdrawn_at IS NULL
           AND (NOT EXISTS (SELECT 1 FROM watermark)
             OR (created_at,id)<=(SELECT created_at,id FROM watermark))
         RETURNING id
       ) SELECT count(*)::int AS changed FROM updated`,
      [account.principalId],
    );
    return context.json({ changed: Number(result.rows[0]?.changed ?? 0) });
  });

  const withdrawAccountNotification = async (context: any) => {
    const account = await accountMutationAccount(context);
    if (account instanceof Response) return account;
    const notificationId = internalId("ntf",context.req.param("notificationId") ?? "");
    if (!notificationId) return context.json({ error: "notification_not_found" },404);
    const client = await db.connect();
    const idempotencyKey = `dashboard:${randomUUID()}`;
    try {
      await client.query("BEGIN");
      const event = await client.query<any>(
        `SELECT id,withdrawn_at FROM notification_events
         WHERE id=$1 AND principal_id=$2 AND kind<>'live_activity' FOR UPDATE`,
        [notificationId,account.principalId],
      );
      if (!event.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "notification_not_found" },404);
      }
      if (event.rows[0].withdrawn_at) {
        await client.query("COMMIT");
        return context.json({ state: "withdrawn",withdrawnAt: event.rows[0].withdrawn_at,replayed: true });
      }
      const updated = await client.query<any>(
        `UPDATE notification_events SET state='withdrawn',withdrawn_at=now(),
           withdrawn_by_kind='dashboard',withdrawn_by_id=$2,updated_at=now()
         WHERE id=$1 RETURNING withdrawn_at`,
        [notificationId,account.principalId],
      );
      await client.query(
        `UPDATE interaction_requests SET state='canceled',responded_at=now()
         WHERE notification_event_id=$1 AND state='pending'`,[notificationId],
      );
      const canceled = await client.query(
        `UPDATE delivery_jobs SET state='canceled',updated_at=now(),last_error_code='notification_withdrawn'
         WHERE notification_event_id=$1 AND state IN ('pending','retry') RETURNING id`,[notificationId],
      );
      await client.query(
        `INSERT INTO notification_withdrawal_evidence(
           principal_id,notification_event_id,requester_kind,requester_id,idempotency_key,outcome
         ) VALUES ($1,$2,'dashboard',$1,$3,'canonical_withdrawn')`,
        [account.principalId,notificationId,idempotencyKey],
      );
      await client.query(
        `INSERT INTO notification_withdrawal_evidence(
           principal_id,notification_event_id,device_id,requester_kind,requester_id,
           idempotency_key,outcome,detail_code
         ) SELECT $1,$2,d.id,'dashboard',$1,$3,'sync_command_queued','inbox_tombstone'
           FROM devices d WHERE d.principal_id=$1 AND d.revoked_at IS NULL`,
        [account.principalId,notificationId,idempotencyKey],
      );
      await client.query("COMMIT");
      return context.json({ state: "withdrawn",withdrawnAt: updated.rows[0].withdrawn_at,
        canceledDeliveries: canceled.rowCount ?? 0,replayed: false });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  };
  app.post("/api/account/notifications/:notificationId/withdraw", withdrawAccountNotification);
  app.post("/api/dashboard/notifications/:notificationId/withdraw", withdrawAccountNotification);

  app.get("/", async (context) => {
    if (await getOwnerAccount(db, accountAuth, context.req.raw.headers)) return context.redirect("/dashboard");
    const claimed = Boolean((await db.query("SELECT 1 FROM account_identities LIMIT 1")).rowCount);
    const mode = claimed ? "sign-in" : "sign-up";
    const heading = claimed ? "Sign in to Relo" : "Create the owner account";
    const subheading = claimed
      ? "Use the same account as your iPhone."
      : "This first account claims the bootstrapped private owner.";
    const name = claimed ? "" : `<label>Name<input name="name" autocomplete="name" required maxlength="120"></label>`;
    const nextPath = safeNextPath(context.req.query("next"));
    const content = `<section class="auth card"><div class="eyebrow">Private notification control plane</div><h1>${heading}</h1><p class="muted">${subheading}</p>
      <form id="auth-form" data-mode="${mode}" data-next="${escapeHtml(nextPath)}">${name}<label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="${claimed ? "current-password" : "new-password"}" minlength="8" maxlength="128" required></label><div class="error" id="error" role="alert"></div><button type="submit">${claimed ? "Sign in" : "Create account"}</button></form></section>`;
    context.header("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    context.header("cache-control","private, no-store");
    return context.html(page("Account", content));
  });

  const notificationDetailPage = async (context: any) => {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.redirect(`/?next=${encodeURIComponent(context.req.path)}`);
    const notificationId = internalId("ntf",context.req.param("notificationId"));
    if (!notificationId) return context.notFound();
    const event = await db.query<any>(
      `SELECT e.id,e.source,e.kind,e.title,e.body,e.image_url,e.deep_link,e.state,e.expires_at,
         e.created_at,e.updated_at,e.target_mode,s.title AS service_title,
         COALESCE(e.payload->>'privacy',e.payload#>>'{liveActivity,privacy}','standard') AS privacy
       FROM notification_events e LEFT JOIN webhook_services s ON s.id=e.service_id
       WHERE e.id=$1 AND e.principal_id=$2`,
      [notificationId,account.principalId],
    );
    if (!event.rowCount) return context.notFound();
    const [request,deliveries,receipts] = await Promise.all([
      db.query<any>(
        `SELECT r.id,r.kind,r.prompt,r.state,r.response,r.expires_at,r.created_at,r.responded_at,
           winner.kind AS response_action,winner.device_id AS response_device_id,d.name AS response_device_name
         FROM interaction_requests r
         LEFT JOIN LATERAL (
           SELECT i.kind,i.device_id FROM interactions i
           WHERE i.interaction_request_id=r.id ORDER BY i.created_at,i.id LIMIT 1
         ) winner ON true
         LEFT JOIN devices d ON d.id=winner.device_id
         WHERE r.notification_event_id=$1 AND r.principal_id=$2`,
        [notificationId,account.principalId],
      ),
      db.query<any>(
        `SELECT j.id,j.transport,j.state,j.attempt_count,j.provider_message_id,j.last_error_code,
           j.last_error_message,j.accepted_at,j.created_at,j.updated_at,d.name AS device_name
         FROM delivery_jobs j JOIN devices d ON d.id=j.device_id
         WHERE j.notification_event_id=$1 AND d.principal_id=$2 ORDER BY j.created_at,j.id`,
        [notificationId,account.principalId],
      ),
      db.query<any>(
        `SELECT i.id,i.kind,i.created_at,d.name AS device_name
         FROM interactions i JOIN devices d ON d.id=i.device_id
         WHERE i.notification_event_id=$1 AND i.principal_id=$2 ORDER BY i.created_at,i.id`,
        [notificationId,account.principalId],
      ),
    ]);
    const row = event.rows[0];
    const e = (value: unknown) => escapeHtml(value === null || value === undefined ? "Not set" : String(value));
    const when = (value: unknown) => value
      ? e(new Date(String(value)).toLocaleString("en",{ dateStyle: "medium",timeStyle: "short" })) : "Not set";
    const badge = (state: unknown) => `<span class="badge" data-state="${e(state)}">${e(state)}</span>`;
    const destination = safeDashboardDestination(row.deep_link);
    const interaction = request.rows[0];
    const response = interaction?.response === null || interaction?.response === undefined
      ? "Not received" : e(typeof interaction.response === "string" ? interaction.response : JSON.stringify(interaction.response));
    const deliveryRows = deliveries.rows.map((item) => `<div class="list-row"><div><strong>${e(item.device_name)}</strong><div class="meta">${badge(item.transport)}${badge(item.state)}<span>${e(item.attempt_count)} attempt${Number(item.attempt_count) === 1 ? "" : "s"}</span></div><div class="muted">${item.last_error_code ? `${e(item.last_error_code)}: ${e(item.last_error_message)}` : item.provider_message_id ? `Provider ID ${e(item.provider_message_id)}` : `Updated ${when(item.updated_at)}`}</div></div><span class="muted">${item.accepted_at ? when(item.accepted_at) : when(item.created_at)}</span></div>`).join("") || '<div class="empty">No provider delivery job was created for this event.</div>';
    const receiptRows = receipts.rows.map((item) => `<div class="list-row"><div><strong>${e(item.kind)}</strong><div class="muted">${e(item.device_name)}</div></div><span class="muted">${when(item.created_at)}</span></div>`).join("") || '<div class="empty">No device receipts or responses yet.</div>';
    const responseAction = interaction?.response_action === "answer" ? "reply" : interaction?.response_action;
    const respondingDevice = interaction?.response_device_id
      ? `${e(interaction.response_device_name || "Unnamed device")} · ${e(publicId("dev",interaction.response_device_id))}` : "Not received";
    const interactionSection = interaction ? `<section class="panel card"><h2>Response request</h2><dl class="detail-grid"><div class="detail"><dt>Type</dt><dd>${e(interaction.kind)}</dd></div><div class="detail"><dt>State</dt><dd>${badge(interaction.state)}</dd></div><div class="detail"><dt>Action</dt><dd>${e(responseAction)}</dd></div><div class="detail"><dt>Responding device</dt><dd>${respondingDevice}</dd></div><div class="detail"><dt>Expires</dt><dd>${when(interaction.expires_at)}</dd></div><div class="detail"><dt>Responded</dt><dd>${when(interaction.responded_at)}</dd></div></dl><h3>Prompt</h3><p class="detail-body">${e(interaction.prompt)}</p><h3>Result</h3><p class="detail-body">${response}</p></section>` : "";
    const content = `${renderDashboardTabs({ label: "Inbox",active: "notifications",tabs: [
      { id: "inbox",label: "Inbox",href: "/dashboard" },
      { id: "notifications",label: "History",href: "/dashboard/inbox/notifications" },
      { id: "delivery",label: "Delivery",href: "/dashboard/inbox/delivery" },
    ] })}<div class="detail-actions"><a class="button secondary" href="/dashboard/inbox/notifications">Back to history</a>${destination ? `<a class="button secondary" href="${e(destination)}" target="_blank" rel="noopener noreferrer">Open destination</a>` : ""}</div><section class="card"><div class="section-head"><div><h2>${e(row.title)}</h2><p class="muted">${e(row.source)}${row.service_title ? ` (${e(row.service_title)})` : ""}</p></div>${badge(row.state)}</div><p class="detail-body">${e(row.body)}</p><dl class="detail-grid"><div class="detail"><dt>Event ID</dt><dd><code class="copyable-id" title="${e(publicId("ntf",row.id))}">${e(publicId("ntf",row.id))}</code></dd></div><div class="detail"><dt>Kind</dt><dd>${e(row.kind)}</dd></div><div class="detail"><dt>Privacy</dt><dd>${e(row.privacy)}</dd></div><div class="detail"><dt>Targeting</dt><dd>${e(row.target_mode)}</dd></div><div class="detail"><dt>Created</dt><dd>${when(row.created_at)}</dd></div><div class="detail"><dt>Updated</dt><dd>${when(row.updated_at)}</dd></div><div class="detail"><dt>Expires</dt><dd>${when(row.expires_at)}</dd></div><div class="detail"><dt>Destination</dt><dd>${destination ? "Validated HTTPS URL" : row.deep_link ? "Unavailable: destination is not safe to open" : "Not set"}</dd></div></dl></section>${interactionSection}<section class="panel card"><h2>Delivery attempts</h2>${deliveryRows}</section><section class="panel card"><h2>Device receipts and responses</h2>${receiptRows}</section>`;
    const initial = escapeHtml(account.user.name.trim().charAt(0).toUpperCase() || "K");
    context.header("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return context.html(renderDashboardDocument({
      active: "inbox-notifications", title: row.title, eyebrow: "Notification detail",
      description: `Persistent event ${publicId("ntf",row.id)}. Payloads, credentials, and idempotency keys are intentionally not displayed.`,
      content, releaseIdentity,
      account: { initial, name: escapeHtml(account.user.name), email: escapeHtml(account.user.email) },
    }));
  };

  type LegacyDashboardSection = Exclude<DashboardSection,"account" | "docs">;
  const dashboardPage = (section: LegacyDashboardSection) => async (context: any) => {
    const account = await getOwnerAccount(db, accountAuth, context.req.raw.headers);
    if (!account) return context.redirect(`/?next=${encodeURIComponent(context.req.path)}`);
    const requestedPage = dashboardPageNumber(context.req.query("page"));
    const requestedActivityId = context.req.param("activityId") ?? context.req.query("activity");
    const requestedActivityInternalId = requestedActivityId ? internalId("act",requestedActivityId) : null;
    if (requestedActivityId && !requestedActivityInternalId) return context.notFound();
    const notificationKind = dashboardNotificationKinds.find((value) => value === context.req.query("kind"));
    const notificationState = dashboardNotificationStates.find((value) => value === context.req.query("state"));
    const counts = await db.query<{
      devices: number; credentials: number; approvals: number; services: number; notifications: number;
      pending_responses: number; notification_history: number; activities: number; deliveries: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM devices WHERE principal_id=$1 AND revoked_at IS NULL) AS devices,
        (SELECT count(*)::int FROM principal_api_keys WHERE principal_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())) AS credentials,
        (SELECT count(*)::int FROM device_authorizations WHERE status='pending' AND expires_at>now()) AS approvals,
        (SELECT count(*)::int FROM interaction_requests WHERE principal_id=$1 AND state='pending' AND expires_at>now()) AS pending_responses,
        (SELECT count(*)::int FROM webhook_services WHERE principal_id=$1 AND revoked_at IS NULL) AS services,
        (SELECT count(*)::int FROM notification_events WHERE principal_id=$1) AS notifications,
        (SELECT count(*)::int FROM notification_events WHERE principal_id=$1
          AND ($2::text IS NULL OR kind::text=$2) AND ($3::text IS NULL OR state::text=$3)) AS notification_history,
        (SELECT count(*)::int FROM live_activities WHERE principal_id=$1
          AND requester_service_id IS NULL AND requester_credential_id IS NULL
          AND activity_key LIKE 'dashboard-test-%') AS activities,
        (SELECT count(*)::int FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
          WHERE e.principal_id=$1) AS deliveries`,
      [account.principalId,notificationKind ?? null,notificationState ?? null],
    );
    const summary = counts.rows[0] ?? {
      devices: 0, credentials: 0, approvals: 0, services: 0, notifications: 0, pending_responses: 0,
      notification_history: 0, activities: 0, deliveries: 0,
    };
    const pageTotal = section === "inbox" ? summary.approvals
      : section === "inbox-notifications" ? summary.notification_history
      : section === "testing" ? summary.activities
      : section === "inbox-delivery" ? summary.deliveries
      : section === "connections-phones" ? summary.devices
      : section === "connections-clients" ? summary.credentials
      : section === "connections-services" ? summary.services : 0;
    const pageCount = Math.max(1,Math.ceil(pageTotal/dashboardHistoryPageSize));
    const historyPage = Math.min(requestedPage,pageCount);
    const historyOffset = (historyPage-1)*dashboardHistoryPageSize;
    const sectionOffset = (target: LegacyDashboardSection) => section === target ? historyOffset : 0;
    const deviceLimit = section === "testing" ? Math.max(1,Number(summary.devices)) : dashboardHistoryPageSize;
    const activityLimit = section === "testing" ? Math.max(1,Number(summary.activities)) : dashboardHistoryPageSize;
    const [devices,credentials,approvals,services,notifications,activities,deliveries,pendingInteractions] = await Promise.all([
      db.query<any>(`SELECT id,name,model,app_version,os_version,notification_authorization,live_activity_authorization,
        last_seen_at
        FROM devices WHERE principal_id=$1 AND revoked_at IS NULL ORDER BY last_seen_at DESC,id DESC LIMIT $2 OFFSET $3`,
      [account.principalId,deviceLimit,sectionOffset("connections-phones")]),
      db.query<any>(`SELECT id,label,token_prefix,scopes,created_at,expires_at,last_used_at FROM principal_api_keys WHERE principal_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
      [account.principalId,dashboardHistoryPageSize,sectionOffset("connections-clients")]),
      db.query<any>(`SELECT user_code,client_name,requested_scopes,expires_at,credential_expires_at FROM device_authorizations WHERE status='pending' AND expires_at>now() ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`,
      [dashboardHistoryPageSize,sectionOffset("inbox")]),
      db.query<any>(`SELECT id,title,secret_prefix,image_url,default_url,created_at FROM webhook_services WHERE principal_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
      [account.principalId,dashboardHistoryPageSize,sectionOffset("connections-services")]),
      db.query<any>(`SELECT e.id,e.source,e.kind,e.title,e.body,e.state,e.created_at,
          targets.device_names,response.action AS response_action,response.responded_at
        FROM notification_events e
        LEFT JOIN LATERAL (
          SELECT string_agg(d.name,', ' ORDER BY d.name,d.id) AS device_names
          FROM notification_event_targets t JOIN devices d ON d.id=t.device_id
          WHERE t.notification_event_id=e.id AND d.principal_id=e.principal_id
        ) targets ON true
        LEFT JOIN LATERAL (
          SELECT i.kind AS action,r.responded_at FROM interaction_requests r
          LEFT JOIN interactions i ON i.interaction_request_id=r.id
          WHERE r.notification_event_id=e.id ORDER BY i.created_at DESC NULLS LAST,r.created_at DESC LIMIT 1
        ) response ON true
        WHERE e.principal_id=$1 AND ($2::text IS NULL OR e.kind::text=$2) AND ($3::text IS NULL OR e.state::text=$3)
        ORDER BY e.created_at DESC,e.id DESC LIMIT $4 OFFSET $5`,
      [account.principalId,notificationKind ?? null,notificationState ?? null,dashboardHistoryPageSize,
        sectionOffset("inbox-notifications")]),
      db.query<any>(`SELECT a.id,a.title,a.detail,a.style,a.status,a.state,a.progress,a.symbol,a.privacy,a.accent_color,
        a.presentation,a.presentation_sha256,a.sequence,a.created_at,a.updated_at,
        a.target_device_ids,target_device.name AS target_device_name,
        run_delivery.job_state AS delivery_state,run_delivery.summary AS delivery_summary,
        run_receipts.expected AS expected_receipts,run_receipts.confirmed AS confirmed_receipts,
        run_interaction.kind AS interaction_kind,run_interaction.state AS interaction_state,
        run_interaction.action AS interaction_action,run_interaction.responded_at AS interaction_responded_at,
        a.requester_service_id,a.requester_credential_id,
        CASE WHEN a.requester_service_id IS NOT NULL THEN 'Service · '||COALESCE(s.title,'revoked')
             WHEN a.requester_credential_id IS NOT NULL THEN 'Client · '||COALESCE(k.label,'revoked') ELSE 'Dashboard' END AS requester_label
        FROM live_activities a LEFT JOIN webhook_services s ON s.id=a.requester_service_id
        LEFT JOIN principal_api_keys k ON k.id=a.requester_credential_id
        LEFT JOIN LATERAL (
          SELECT d.name FROM devices d WHERE d.principal_id=a.principal_id
            AND d.id=ANY(a.target_device_ids) ORDER BY d.name,d.id LIMIT 1
        ) target_device ON true
        LEFT JOIN LATERAL (
          SELECT e.delivery_summary AS summary,j.state AS job_state
          FROM notification_events e LEFT JOIN delivery_jobs j ON j.notification_event_id=e.id
          WHERE e.principal_id=a.principal_id AND (
            e.payload#>>'{liveActivity,activityId}'='act_'||a.id::text OR
            e.payload#>>'{workbench,parentActivityId}'='act_'||a.id::text)
          ORDER BY e.created_at DESC,j.updated_at DESC NULLS LAST LIMIT 1
        ) run_delivery ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS expected,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM interactions i WHERE i.notification_event_id=e.id
                AND i.device_id=t.device_id AND i.kind='received'))::int AS confirmed
          FROM notification_events e JOIN notification_event_targets t ON t.notification_event_id=e.id
          WHERE e.principal_id=a.principal_id
            AND e.payload#>>'{liveActivity,activityId}'='act_'||a.id::text
            AND e.payload#>>'{liveActivity,sequence}'=a.sequence::text
        ) run_receipts ON true
        LEFT JOIN LATERAL (
          SELECT r.kind,r.state,i.kind AS action,r.responded_at
          FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
          LEFT JOIN interactions i ON i.interaction_request_id=r.id
          WHERE e.principal_id=a.principal_id AND (
            e.payload#>>'{liveActivity,activityId}'='act_'||a.id::text OR
            e.payload#>>'{workbench,parentActivityId}'='act_'||a.id::text)
          ORDER BY r.created_at DESC,i.created_at DESC NULLS LAST LIMIT 1
        ) run_interaction ON true
        WHERE a.principal_id=$1 AND a.requester_service_id IS NULL
          AND a.requester_credential_id IS NULL
          AND a.activity_key LIKE 'dashboard-test-%'
        ORDER BY CASE WHEN a.state='active' THEN 0 ELSE 1 END,
          CASE WHEN a.id=$4::uuid THEN 0 ELSE 1 END,a.updated_at DESC,a.id DESC LIMIT $2 OFFSET $3`,
      [account.principalId,activityLimit,section === "testing" ? 0 : historyOffset,requestedActivityInternalId]),
      db.query<any>(`SELECT j.id,j.state,j.attempt_count,j.provider_message_id,j.last_error_code,j.last_error_message,
        j.accepted_at,j.created_at,j.updated_at,e.id AS event_id,e.title,e.source,d.name AS device_name
        FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
        JOIN devices d ON d.id=j.device_id WHERE e.principal_id=$1
        ORDER BY j.updated_at DESC,j.id DESC LIMIT $2 OFFSET $3`,
      [account.principalId,dashboardHistoryPageSize,historyOffset]),
      db.query<any>(`SELECT r.id,r.kind,r.prompt,r.state,r.created_at,r.expires_at,e.id AS event_id,
          e.source,e.title,targets.device_names
        FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
        LEFT JOIN LATERAL (
          SELECT string_agg(d.name,', ' ORDER BY d.name,d.id) AS device_names
          FROM notification_event_targets t JOIN devices d ON d.id=t.device_id
          WHERE t.notification_event_id=e.id AND d.principal_id=e.principal_id
        ) targets ON true
        WHERE r.principal_id=$1 AND r.state='pending' AND r.expires_at>now()
        ORDER BY r.created_at DESC,r.id DESC LIMIT $2`,
      [account.principalId,dashboardHistoryPageSize]),
    ]);
    if (section === "testing") {
      const selectedActivity = requestedActivityId
        ? activities.rows.find((row) => publicId("act",row.id) === requestedActivityId) : null;
      if (requestedActivityId && !selectedActivity) return context.notFound();
      const bootstrap = createTestLabDashboardBootstrap({
        path: context.req.path,
        selectedActivityId: selectedActivity ? publicId("act",selectedActivity.id) : null,
        compose: context.req.query("compose") === "1",
        releaseIdentity,
        account: { id: account.accountId,name: account.user.name,email: account.user.email },
        devices: devices.rows,
        activities: activities.rows,
        presets: LIVE_ACTIVITY_PRESET_IDS.map((id) => ({
          id,
          label: liveActivityGallery[id].label,
          presentation: dashboardBuilderPresetPresentation(id),
        })),
      });
      context.header("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      context.header("x-content-type-options","nosniff");
      return context.html(await renderDashboardAppDocument(bootstrap));
    }
    const initial = escapeHtml(account.user.name.trim().charAt(0).toUpperCase() || "K");
    const name = escapeHtml(account.user.name);
    const email = escapeHtml(account.user.email);
    const accountId = escapeHtml(account.accountId);
    const e = (value: unknown) => escapeHtml(value === null || value === undefined ? "—" : String(value));
    const when = (value: unknown) => value ? e(new Date(String(value)).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })) : "—";
    const empty = (message: string) => `<div class="empty">${escapeHtml(message)}</div>`;
    const badge = (state: unknown) => `<span class="badge" data-state="${e(state)}">${e(state)}</span>`;
    const deviceRows = devices.rows.map((row) => `<div class="list-row"><div><strong>${e(row.name)}</strong><div class="meta"><span>${e(row.model)} · iOS ${e(row.os_version)} · app ${e(row.app_version)}</span>${badge(row.notification_authorization)}${badge(`Live ${row.live_activity_authorization}`)}</div><div class="muted">Seen <span data-device-last-seen="${e(publicId("dev",row.id))}">${when(row.last_seen_at)}</span></div></div><button class="destructive" data-action="revoke-device" data-id="${e(publicId("dev",row.id))}" data-confirm="Revoke this iPhone and cancel its queued delivery?">Revoke</button></div>`).join("") || empty("No registered iPhones yet.");
    const credentialRows = credentials.rows.map((row) => `<div class="list-row"><div><strong>${e(row.label)}</strong><div class="meta"><code>${e(row.token_prefix)}</code><span>${e(row.scopes.join(", "))}</span></div><div class="muted">Created ${when(row.created_at)} · expires ${when(row.expires_at)} · last used <span data-client-last-used="${e(publicId("key",row.id))}">${when(row.last_used_at)}</span></div></div><button class="destructive" data-action="revoke-credential" data-id="${e(publicId("key",row.id))}" data-confirm="Revoke this CLI client credential?">Revoke</button></div>`).join("") || empty("No active CLI clients.");
    const approvalRows = approvals.rows.map((row) => `<div class="list-row"><div><strong>${e(row.client_name)}</strong><div><code>${e(row.user_code)}</code></div><div class="muted">${e(row.requested_scopes.join(", "))} · approval expires ${when(row.expires_at)} · credential expires ${when(row.credential_expires_at)}</div></div><div class="actions"><button class="secondary" data-action="deny-approval" data-code="${e(row.user_code)}">Deny</button><button data-action="approve-approval" data-code="${e(row.user_code)}">Authorize</button></div></div>`).join("") || empty("No clients are waiting for approval.");
    const serviceRows = services.rows.map((row) => `<div class="list-row service-row"><div class="service-summary"><strong>${e(row.title)}</strong><div class="meta"><code>${e(row.secret_prefix)}</code><span>created ${when(row.created_at)}</span></div><div class="muted">Default tap URL: ${e(row.default_url)} · avatar: ${row.image_url ? "configured" : "not configured"}</div><form class="service-edit-form" data-service-id="${e(publicId("svc",row.id))}"><label>Name<input name="title" maxlength="80" required value="${e(row.title)}"></label><label>Avatar image URL<input name="imageUrl" type="url" inputmode="url" placeholder="https://…" value="${row.image_url ? e(row.image_url) : ""}"></label><label>Default tap URL<input name="destinationUrl" type="url" inputmode="url" placeholder="https://…" value="${row.default_url ? e(row.default_url) : ""}"></label><button class="secondary" type="submit">Save defaults</button></form></div><div class="actions"><button class="secondary" data-action="rotate-service" data-id="${e(publicId("svc",row.id))}" data-confirm="Rotate this secret URL? The previous URL will stop working.">Rotate URL</button><button class="destructive" data-action="revoke-service" data-id="${e(publicId("svc",row.id))}" data-confirm="Delete this webhook service?">Delete</button></div></div>`).join("") || empty("Create a named service to receive a secret webhook URL.");
    const notificationRows = notifications.rows.map((row) => {
      const id = publicId("ntf",row.id);
      const outcome = row.response_action
        ? `<span>response ${e(row.response_action)} at ${when(row.responded_at)}</span>` : "";
      return `<a class="list-row history-link" href="/dashboard/inbox/notifications/${e(id)}"><div><strong>${e(row.title)}</strong><div class="meta"><span>${e(row.source)}</span>${badge(row.kind)}${badge(row.state)}<span>${when(row.created_at)}</span></div><div class="muted">${e(row.body)}</div><div class="meta"><span>Target ${e(row.device_names || "No active device")}</span>${outcome}</div></div><code class="compact-id" title="${e(id)}">${e(id)}</code></a>`;
    }).join("") || empty("No notifications match these filters.");
    const pendingResponseRows = pendingInteractions.rows.map((row) => {
      const eventId = publicId("ntf",row.event_id);
      return `<a class="list-row history-link" href="/dashboard/inbox/notifications/${e(eventId)}"><div><strong>${e(row.title)}</strong><div class="meta"><span>${e(row.source)}</span>${badge(row.kind)}${badge(row.state)}<span>Target ${e(row.device_names || "No active device")}</span></div><div class="muted">${e(row.prompt)}</div></div><span class="run-row-tail"><time>Created ${when(row.created_at)}</time><time>Expires ${when(row.expires_at)}</time></span></a>`;
    }).join("") || empty("No phone responses are waiting.");
    const deliveryRows = deliveries.rows.map((row) => `<a class="list-row history-link" href="/dashboard/inbox/notifications/${e(publicId("ntf",row.event_id))}"><div><strong>${e(row.title)}</strong><div class="meta"><span>${e(row.source)} to ${e(row.device_name)}</span>${badge(row.state)}<span>${e(row.attempt_count)} attempt${Number(row.attempt_count) === 1 ? "" : "s"}</span></div><div class="muted">${row.last_error_code ? `${e(row.last_error_code)}: ${e(row.last_error_message)}` : row.provider_message_id ? `Provider ID ${e(row.provider_message_id)}` : `Updated ${when(row.updated_at)}`}</div></div><span class="muted">${row.accepted_at ? when(row.accepted_at) : when(row.created_at)}</span></a>`).join("") || empty("No remote delivery attempts yet.");
    const activityPager = `<p class="pagination-summary">${e(summary.activities)} total</p>`;
    const requestedActivity = requestedActivityId
      ? activities.rows.find((row) => publicId("act",row.id) === requestedActivityId) : null;
    if (requestedActivityId && !requestedActivity) return context.notFound();
    const selectedActivity = requestedActivity;
    const selectedActivityId = selectedActivity ? publicId("act",selectedActivity.id) : null;
    const activeRunCount = activities.rows.filter((row) => row.state === "active").length;
    const awaitingPhoneCount = activities.rows.filter((row) =>
      Number(row.expected_receipts) > Number(row.confirmed_receipts),
    ).length;
    const awaitingProviderCount = activities.rows.filter((row) =>
      row.state === "active" && !row.delivery_state,
    ).length;
    const awaitingResponseCount = activities.rows.filter((row) =>
      row.interaction_state === "pending",
    ).length;
    const activityRows = () => activities.rows.map((row) => {
      const id = e(publicId("act",row.id));
      const isSelected = selectedActivityId === publicId("act",row.id);
      const rowPresentation = presentationFromRow(row);
      const requestedRowAccent = dashboardPresentationAccent(rowPresentation);
      const rowAccent = /^#[0-9a-f]{6}$/i.test(requestedRowAccent)
        ? requestedRowAccent.toLowerCase() : "#ff6b5e";
      const percent = row.progress === null ? "—" : `${Math.round(Number(row.progress)*100)}%`;
      const provider = row.delivery_state ?? (Number(row.delivery_summary?.durableCommands ?? 0) ? "server accepted" : "not queued");
      const receipt = Number(row.expected_receipts) > 0
        ? `${e(row.confirmed_receipts)}/${e(row.expected_receipts)} phone receipt` : "no phone receipt expected";
      const interaction = row.interaction_kind
        ? `${e(row.interaction_kind)} ${e(row.interaction_action ?? row.interaction_state)}${row.interaction_responded_at ? ` · ${when(row.interaction_responded_at)}` : ""}`
        : "no response requested";
      return `<article class="run-entry${isSelected ? " is-expanded" : ""}" style="--run-accent:${e(rowAccent)}" id="run-${id}" data-run-id="${id}" data-state="${e(row.state)}" data-slot="test-run-row"><a class="workbench-activity${isSelected ? " is-selected" : ""}" href="/dashboard/testing/runs/${id}#activity-session" data-state="${e(row.state)}" aria-expanded="${isSelected}"${isSelected ? ' aria-current="page" aria-controls="activity-session"' : ""}><span class="run-card-main"><span class="run-card-title"><strong>${e(row.title)}</strong><span class="badge" data-run-state data-state="${e(row.state)}">${e(row.state)}</span></span><code class="compact-id" title="${id}">${id}</code><span class="run-card-summary"><span>${e(row.target_device_name ?? "Unavailable")}</span><span>Sequence <b data-run-sequence>${e(row.sequence)}</b></span><span data-run-progress>${e(percent)}</span></span><span class="run-card-evidence"><span data-run-server-state>${e(row.state)}</span><span>${e(provider)}</span><span>${receipt}</span></span>${row.interaction_kind ? `<span class="run-card-response">${interaction}</span>` : ""}</span><span class="run-row-tail"><time>${when(row.updated_at)}</time><span class="run-expand-label">${isSelected ? "Open" : "View details"}</span></span></a></article>`;
    }).join("") || `<div class="empty" data-slot="test-runs-empty"><strong>No test runs yet.</strong><p>Start one bounded run when an authorized iPhone is ready. Each launch gets its own activity ID and replaces the previous active Test Lab run on that phone.</p><a class="button secondary" href="/dashboard/testing?compose=1#activity-builder-panel">Create the first run</a></div>`;
    const galleryDevices = devices.rows.filter((row) =>
      row.live_activity_authorization === "authorized"
        && ["authorized", "provisional"].includes(row.notification_authorization),
    );
    const galleryDeviceOptions = galleryDevices.map((row) => `<option value="${e(publicId("dev",row.id))}">${e(row.name)}</option>`).join("");
    const galleryDisabled = galleryDevices.length ? "" : " disabled";
    const galleryPreview = (style: (typeof liveActivityStyles)[number],current?: {
      headline: string; status: string; detail: string; progress: number | null; accent?: string;
    },appearance?: { accentColor?: string }) => {
      const sample = current ?? liveActivityGallery[style];
      const contract = liveActivityVisualContract[style];
      const requestedAccent = appearance?.accentColor ?? current?.accent ?? "";
      const accent = /^#[0-9a-f]{6}$/i.test(requestedAccent)
        ? requestedAccent.toLowerCase() : "#47e8b8";
      const percent = sample.progress === null ? null : Math.round(sample.progress*100);
      const top = `<div class="preview-top"><b>✦</b><span>Relo</span><span class="preview-spacer"></span><b data-preview-percent>${percent === null ? e(sample.status) : e(`${percent}%`)}</b></div>`;
      const title = `<div class="preview-title" data-preview-title>${e(sample.headline)}</div>`;
      const status = `<div class="preview-status" data-preview-status>${e(sample.status)}</div>`;
      const detail = `<div class="preview-detail" data-preview-detail>${e(sample.detail)}</div>`;
      const bar = sample.progress === null ? "" : `<div class="preview-bar"></div>`;
      const actions = (primary: string, secondary: string) => `<div class="preview-actions"><i>${primary}</i><i>${secondary}</i></div>`;
      let body: string;
      switch (style) {
      case "hero":
        body = `${top}<div class="preview-hero">${status}${title}${detail}${bar}</div>`;
        break;
      case "terminal":
        body = `${top}<div class="preview-terminal"><div><span class="prompt">$</span> ${title}</div><div>&gt; ${detail}</div><div># ${status}</div></div>${bar}`;
        break;
      case "steps":
        body = `${top}${title}<div class="preview-segments"><i></i><i></i><i></i><i></i><i></i></div>${status}${detail}`;
        break;
      case "approval":
        body = `${top}<div class="preview-row"><div class="preview-signal">◆</div><div>${status}${title}${detail}</div></div>${actions("Approve", "Deny")}`;
        break;
      case "shell":
        body = `<div class="preview-top"><b>~/relo</b><span class="preview-spacer"></span>${status}</div><div class="preview-terminal"><div><span class="prompt">❯</span> ${title}</div><div># ${detail}</div></div>${actions("[ allow ]", "[ reject ]")}`;
        break;
      case "verdict":
        body = `${top}<div class="preview-row"><div class="preview-signal">✓</div><div>${status}${title}</div></div>${detail}${actions("YES", "NO")}`;
        break;
      case "signal":
        body = `<div class="preview-row"><div class="preview-signal">≋</div><div>${status}${title}${detail}</div></div>${actions("Respond", "Dismiss")}`;
        break;
      default:
        body = `${top}${status}${title}${detail}${bar}`;
      }
      return `<span class="surface-label">Lock Screen</span><div class="activity-preview style-${e(style)}" style="--la:${e(accent)}" data-notification-accent="${e(accent)}" data-preview-progress="${e(percent ?? 0)}" data-native-surface="lock-screen" data-native-layout="${contract.layout}" data-native-regions="${contract.lock}" data-native-accent="${contract.accent}" data-native-secondary="${contract.secondary}" data-native-corner-radius="25" data-native-padding="16" aria-hidden="true">${body}</div>`;
    };
    const galleryIslandPreview = (style: (typeof liveActivityStyles)[number],current?: {
      headline: string; status: string; detail: string; progress: number | null;
    }) => {
      const sample = current ?? liveActivityGallery[style];
      const contract = liveActivityVisualContract[style];
      const symbol = style === "terminal" || style === "shell" ? "›_" : style === "approval" || style === "verdict" ? "◆" : style === "signal" ? "≋" : style === "steps" ? "▰" : "✦";
      const leading = `<b>${symbol}</b>`;
      const trailing = sample.progress === null ? sample.status.slice(0, 6).toUpperCase() : `${Math.round(sample.progress * 100)}%`;
      const text = `<div><strong data-preview-island-title>${e(sample.headline)}</strong><span class="preview-detail">${e(sample.detail)}</span></div>`;
      const actions = `<div class="preview-actions"><i>${style === "verdict" || style === "signal" ? "Yes" : "Approve"}</i><i>${style === "verdict" || style === "signal" ? "No" : "Deny"}</i></div>`;
      let bottom: string;
      switch (style) {
      case "hero": bottom = `<div class="preview-hero"><div class="preview-status">${e(sample.status.toUpperCase())}</div><strong>${e(sample.headline)}</strong></div>`; break;
      case "terminal": bottom = `<div class="preview-terminal"><strong>$ ${e(sample.headline)}</strong><span>&gt; ${e(sample.detail)}</span></div>`; break;
      case "steps": bottom = `${text}<div class="preview-segments"><i></i><i></i><i></i><i></i><i></i></div>`; break;
      case "approval": bottom = `<div class="preview-row"><div class="preview-signal">◆</div>${text}</div>${actions}`; break;
      case "shell": bottom = `<div class="preview-terminal"><strong>❯ ${e(sample.headline)}</strong></div>${actions}`; break;
      case "verdict": bottom = `<div class="preview-row"><div class="preview-signal">✓</div>${text}</div>${actions}`; break;
      case "signal": bottom = `<div class="preview-row"><div class="preview-signal">≋</div>${text}</div>${actions}`; break;
      default: bottom = `${text}<div class="preview-bar"></div>`;
      }
      return `<span class="surface-label">Dynamic Island / expanded</span><div class="island-expanded style-${e(style)}" data-preview-progress="${e(sample.progress === null ? 0 : Math.round(sample.progress*100))}" data-native-surface="expanded" data-native-regions="leading:source,trailing:status,bottom:${contract.bottom}" aria-hidden="true"><div class="island-regions"><span data-native-region="leading">${leading}<b>Relo</b></span><strong data-native-region="trailing" data-preview-island-trailing>${e(trailing)}</strong></div><div class="island-bottom" data-native-region="bottom">${bottom}</div></div><span class="surface-label">Dynamic Island / compact + minimal</span><div class="island-preview style-${e(style)}" data-native-surface="compact" data-native-regions="leading:symbol,trailing:status" aria-hidden="true">${leading}<strong data-preview-island-trailing>${e(trailing)}</strong></div><div class="island-minimal style-${e(style)}" data-native-surface="minimal" data-native-regions="symbol" aria-hidden="true">${leading}</div>`;
    };
    const standardBuilderPreset = dashboardBuilderPresetPresentation("standard");
    const builderPresetOptions = LIVE_ACTIVITY_PRESET_IDS.map((style) => {
      const presentation = dashboardBuilderPresetPresentation(style);
      return `<option value="${e(style)}" data-presentation="${e(JSON.stringify(presentation))}"${style === "standard" ? " selected" : ""}>${e(liveActivityGallery[style].label)}</option>`;
    }).join("");
    const builderPreview = `<section class="activity-builder-preview theme-system" style="--la:${e(dashboardPresentationAccent(standardBuilderPreset).toLowerCase())}" data-activity-builder data-theme="system" data-preview-accent="${e(dashboardPresentationAccent(standardBuilderPreset).toLowerCase())}" aria-label="Configured Lock Screen preview"><span class="surface-label">Lock Screen preview</span><div class="activity-preview builder-lock-screen" data-preview-progress="42" data-native-surface="lock-screen"><div class="builder-preview-header"><span><b data-builder-preview-symbol>◆</b> <span data-builder-preview-header>Relo</span></span><span data-builder-preview-status>Building</span></div><h3 data-builder-preview-title>Release #42</h3><p data-builder-preview-subtitle>Compiling the Relo notification pipeline</p><div class="builder-visual" data-builder-visual="progress_bar"><div class="preview-bar"><i></i></div><span data-builder-preview-percent>42%</span></div><div class="builder-visual builder-steps" data-builder-visual="steps" hidden></div><div class="builder-visual builder-actions" data-builder-behavior-preview="actions" hidden><span data-builder-preview-secondary>Deny</span><span class="is-primary" data-builder-preview-primary>Approve</span></div></div></section>`;
    const noPhoneRecovery = galleryDevices.length ? "" : `<p class="callout" data-slot="test-lab-device-recovery"><strong>No authorized iPhone is ready.</strong> Register a phone and allow notifications and Live Activities in <a href="/dashboard/connections/phones">Connections → Registered phones</a>.</p>`;
    const composerOpen = context.req.query("compose") === "1" ? " open" : "";
    const builder = `<details class="card workbench-builder" id="activity-builder-panel" data-slot="test-run-composer"${composerOpen}><summary><strong>New run</strong><span class="muted">Compose a separate durable activity ID</span></summary><div class="section-head builder-heading"><div><h2>Launch a new test run</h2><p class="muted">Choose a target and behavior, then tune only the relevant fields. Your draft stays ready after launch.</p></div><span class="badge" data-state="active">Current presentation</span></div>${noPhoneRecovery}<div class="builder-layout"><form id="activity-builder-form" class="builder-form"><fieldset class="builder-group builder-launch-group"><legend>Target and behavior</legend><div class="builder-fields"><label>Target iPhone<select id="activity-device" required${galleryDisabled}>${galleryDeviceOptions || "<option>No fully authorized iPhone</option>"}</select></label><label>Preset shortcut<select id="builder-preset">${builderPresetOptions}</select><small>Start from a preset, then tune any field.</small></label></div><div class="builder-fields"><label>Behavior<select id="builder-behavior"><option value="informational">Information only</option><option value="progress" selected>Progress</option><option value="approval">Approval CTA</option><option value="yes_no">Yes / no CTA</option></select></label><label>Visual<select id="builder-visual"><option value="none">No visual</option><option value="progress_bar" selected>Progress bar</option><option value="steps">Stepped progress</option></select></label></div><div class="builder-fields builder-relevant-fields builder-visual" data-builder-progress-fields><label class="progress-control"><span>Starting progress <output id="builder-progress-output" for="builder-progress">42%</output></span><input id="builder-progress" type="range" min="0" max="100" value="42"></label><label>Progress label<input id="builder-progress-label" maxlength="32" placeholder="Optional label"></label></div><div class="builder-fields builder-relevant-fields builder-visual" data-builder-steps-control hidden><label>Step labels<input id="builder-step-labels" value="Queued, In progress, Complete" aria-describedby="builder-step-help"></label><label>Current position<input id="builder-step-current" type="number" min="1" max="4" value="2"><small id="builder-step-help">Up to 8 comma-separated labels.</small></label></div><div class="builder-fields builder-relevant-fields builder-visual" data-builder-action-labels hidden><label>Primary action<input id="builder-primary-label" maxlength="24" value="Approve"></label><label>Secondary action<input id="builder-secondary-label" maxlength="24" value="Deny"></label></div></fieldset><fieldset class="builder-group builder-content"><legend>Run content</legend><div class="builder-fields"><label>Title<input id="builder-title" maxlength="80" value="${e(standardBuilderPreset.content.title)}" required></label><label>Status<input id="builder-status" maxlength="80" value="${e(standardBuilderPreset.content.status)}" required></label></div></fieldset><details class="builder-options"><summary>Advanced content and appearance</summary><div class="builder-options-body"><div class="builder-fields"><label>Header<input id="builder-header" maxlength="40" value="${e(standardBuilderPreset.content.header ?? "")}"></label><label>Subtitle<input id="builder-subtitle" maxlength="120" value="${e(standardBuilderPreset.content.subtitle ?? "")}"></label></div><div class="builder-fields"><label>Symbol<select id="builder-symbol">${["terminal","code","build","success","warning","info","question","reply","image","lock"].map((symbol) => `<option value="${symbol}"${standardBuilderPreset.state.icon === symbol ? " selected" : ""}>${e(symbol.replace("_"," "))}</option>`).join("")}</select></label><label>Theme<select id="builder-theme"><option value="system" selected>System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div><div class="builder-fields"><label>Accent color<input id="builder-accent-color" type="color" value="${e(dashboardPresentationAccent(standardBuilderPreset).toLowerCase())}"></label></div></div></details><div class="builder-runtime"><p class="builder-gate-note" data-builder-gate-note>Progress behavior enables per-ID updates after launch.</p><p id="builder-operation" class="operation-feedback" data-state="idle" role="status" aria-live="polite">Draft changes are saved for this browser session.</p></div><div class="builder-submit-row"><div class="actions"><button id="start-live-activity" type="submit"${galleryDisabled}>Launch new run</button><button class="secondary" type="button" data-builder-reset>Reset draft</button></div><span>Creates one durable, independently controllable run.</span></div></form><div class="builder-preview-column">${builderPreview}<details class="builder-capabilities"><summary>Runtime notes</summary><p>Image and Live Activity text reply are unavailable in the current end-to-end runtime and are omitted from every request.</p></details></div></div></details>`;
    const selectedOwned = selectedActivity && !selectedActivity.requester_service_id
      && !selectedActivity.requester_credential_id;
    const selectedPresentation = selectedActivity ? presentationFromRow(selectedActivity) : null;
    const selectedProgress = selectedPresentation
      ? dashboardPresentationProgress(selectedPresentation) : null;
    const selectedPercent = selectedProgress === null ? 0 : Math.round(selectedProgress*100);
    const selectedHasProgress = selectedPresentation?.behavior.type === "progress";
    const selectedPreviewContent = selectedPresentation ? {
      headline: selectedPresentation.content.title,
      status: selectedPresentation.content.status,
      detail: selectedPresentation.content.subtitle ?? "",
      progress: selectedProgress,
      accent: dashboardPresentationAccent(selectedPresentation),
    } : undefined;
    const selectedPresentationSummary = selectedPresentation
      ? `${selectedPresentation.behavior.type} · ${dashboardPresentationVisualSummary(selectedPresentation)} · ${selectedPresentation.appearance.theme} · ${selectedPresentation.privacy}`
      : "Presentation unavailable";
    const selectedIsActive = selectedActivity?.state === "active";
    const progressControls = selectedIsActive && selectedHasProgress ? `<div class="run-update-controls" data-slot="test-run-progress-controls"><label>Status<input id="activity-status" maxlength="60" value="${e(selectedPresentation?.content.status ?? "Updated")}"></label><label class="progress-control"><span>Progress <output id="activity-progress-output" for="activity-progress">${e(selectedPercent)}%</output></span><input id="activity-progress" type="range" min="0" max="100" value="${e(selectedPercent)}"></label><button data-workbench-action data-action="update-live-activity">Send update to this run</button></div>` : "";
    const canRequestResponse = selectedIsActive && selectedActivity?.interaction_state !== "pending";
    const responseControls = canRequestResponse && selectedPresentation?.behavior.type === "approval"
      ? `<div class="run-update-controls" data-slot="test-run-response-controls"><label>Approval prompt<input id="activity-prompt" maxlength="180" value="${e(selectedPresentation.content.subtitle ?? selectedPresentation.content.title)}"></label><button data-workbench-action data-action="wait-live-activity" data-kind="approval">Request approval</button></div>`
      : canRequestResponse && selectedPresentation?.behavior.type === "yes_no"
        ? `<div class="run-update-controls" data-slot="test-run-response-controls"><label>Decision prompt<input id="activity-prompt" maxlength="180" value="${e(selectedPresentation.content.subtitle ?? selectedPresentation.content.title)}"></label><button data-workbench-action data-action="wait-live-activity" data-kind="yes_no">Request yes or no</button></div>`
        : "";
    const selectedProviderEvidence = selectedActivity?.delivery_state
      ?? (Number(selectedActivity?.delivery_summary?.durableCommands ?? 0) ? "Server command committed; APNs state pending" : "No provider command yet");
    const selectedPhoneEvidence = Number(selectedActivity?.expected_receipts) > 0
      ? `${e(selectedActivity?.confirmed_receipts)}/${e(selectedActivity?.expected_receipts)} exact-event phone confirmation`
      : "No exact-event phone confirmation expected yet";
    const selectedResponseEvidence = selectedActivity?.interaction_kind
      ? `${e(selectedActivity.interaction_kind)} · ${e(selectedActivity.interaction_action ?? selectedActivity.interaction_state)}`
      : "No response requested for this run";
    const observerControls = selectedOwned ? `<div class="run-observer-actions"><button class="secondary" data-workbench-observer data-receipt-recovery data-action="retry-live-activity-receipt">Check exact phone confirmation</button><a class="button secondary" href="/dashboard/testing/runs/${e(selectedActivityId)}/history">Lifecycle history</a></div>` : "";
    const ownerControls = selectedOwned ? `<div class="workbench-controls" aria-label="Controls for ${e(selectedActivity?.title)}">${selectedIsActive ? `${progressControls}${responseControls}<div class="run-mutation-actions"><button class="destructive" data-workbench-action data-action="end-live-activity" data-confirm="Finish only ${e(selectedActivity?.title)} (${e(selectedActivityId)})? This closes future updates and response requests for this run.">Finish this run</button></div>` : `<p class="muted" data-slot="test-run-terminal-note">This run is terminal. Mutation controls are closed; confirmation and lifecycle evidence remain available.</p>`}${observerControls}</div>` : `<p class="callout">This run belongs to another requester. It is observable here, but its credential retains lifecycle control.</p>`;
    const session = selectedActivity ? `<section class="workbench-session" id="activity-session" data-slot="test-run-detail" data-workbench-session data-activity-id="${e(selectedActivityId)}" data-activity-sequence="${e(selectedActivity.sequence)}" data-activity-presentation="${e(JSON.stringify(selectedPresentation))}" data-state="${e(selectedActivity.state)}" aria-label="Selected run: ${e(selectedActivity.title)}"><div class="section-head run-session-heading"><div><h3 data-activity-title>${e(selectedActivity.title)}</h3><code class="compact-id" title="${e(selectedActivityId)}">${e(selectedActivityId)}</code></div><span class="badge" data-activity-state data-state="${e(selectedActivity.state)}">${e(selectedActivity.state)}</span></div><div class="run-detail-layout"><div class="workbench-selected-preview">${galleryPreview(selectedActivity.style,selectedPreviewContent)}</div><div class="run-detail-panel"><div class="run-inline-meta"><span><b>Target</b><span data-activity-targets>${e(selectedActivity.target_device_name ?? "No target device record")}</span></span><span><b>Presentation</b><span data-activity-presentation-summary>${e(selectedPresentationSummary)}</span></span></div><ol class="run-status-timeline" aria-label="Delivery evidence for the selected run"><li data-stage="server"><span class="timeline-marker" aria-hidden="true"></span><div><span class="timeline-label">Server</span><b data-activity-server>${e(selectedPresentation?.content.status ?? selectedActivity.status)} · sequence ${e(selectedActivity.sequence ?? "not available")}</b></div></li><li data-stage="provider"><span class="timeline-marker" aria-hidden="true"></span><div><span class="timeline-label">Provider</span><b data-activity-delivery>${e(selectedProviderEvidence)}</b></div></li><li data-stage="phone"><span class="timeline-marker" aria-hidden="true"></span><div><span class="timeline-label">Phone</span><b data-activity-receipt>${selectedPhoneEvidence}</b></div></li><li data-stage="response"><span class="timeline-marker" aria-hidden="true"></span><div><span class="timeline-label">Response</span><b data-activity-interaction>${selectedResponseEvidence}</b></div></li></ol><p class="timeline-note">Provider acceptance, exact-event phone confirmation, and interaction response are separate evidence.</p>${ownerControls}<p id="workbench-operation" class="operation-feedback" data-state="idle" role="status" aria-live="polite">Monitoring this run’s exact-ID lifecycle evidence.</p><details class="run-identity"><summary>Run identity and timestamps</summary><dl><div><dt>Activity ID</dt><dd><code class="copyable-id" role="button" tabindex="0" title="${e(selectedActivityId)}" aria-label="Copy activity ID ${e(selectedActivityId)}">${e(selectedActivityId)}</code></dd></div><div><dt>Created</dt><dd>${when(selectedActivity.created_at)}</dd></div><div><dt>Updated</dt><dd>${when(selectedActivity.updated_at)}</dd></div></dl></details></div></div></section>` : `<section class="workbench-session is-empty" id="activity-session" data-slot="test-run-detail"><div class="empty"><strong>Select evidence by creating a run.</strong><p>The monitor keeps each activity ID, command sequence, provider state, phone confirmation, and response independent.</p><a class="button secondary" href="/dashboard/testing?compose=1#activity-builder-panel">Open New run</a></div><p id="workbench-operation" class="operation-feedback" data-state="idle" role="status" aria-live="polite">No run selected.</p></section>`;
    const sessionPanel = selectedActivity ? `<div class="sheet-layer" data-slot="sheet"><a class="sheet-backdrop" href="/dashboard/testing" aria-label="Close run details"></a>${session
      .replace('<section class="workbench-session"','<section class="workbench-session sheet-content" role="dialog" aria-modal="true" aria-labelledby="run-sheet-title"')
      .replace('<div class="section-head run-session-heading">','<div class="sheet-toolbar"><span>Run details</span><a class="sheet-close" href="/dashboard/testing">Close</a></div><div class="section-head run-session-heading">')
      .replace('<h3 data-activity-title>','<h2 id="run-sheet-title" data-activity-title>')}</div>` : "";
    const builderPanel = composerOpen ? `<div class="sheet-layer" data-slot="sheet"><a class="sheet-backdrop" href="/dashboard/testing" aria-label="Close new run composer"></a>${builder
      .replace('<details class="card workbench-builder"','<details class="card workbench-builder sheet-content" role="dialog" aria-modal="true" aria-labelledby="builder-sheet-title"')
      .replace('<div class="section-head builder-heading">','<div class="sheet-toolbar"><span>New run</span><a class="sheet-close" href="/dashboard/testing">Close</a></div><div class="section-head builder-heading">')
      .replace('<h2>Launch a new test run</h2>','<h2 id="builder-sheet-title">Launch a new test run</h2>')}</div>` : "";
    const finishAllDisabled = activeRunCount ? "" : ' disabled data-terminal="true"';
    const composerHref = `${selectedActivityId ? `/dashboard/testing/runs/${e(selectedActivityId)}` : "/dashboard/testing"}?compose=1#activity-builder-panel`;
    const workbench = `<div class="lab-workspace" data-slot="test-lab"><section class="card run-overview" aria-labelledby="test-runs-heading" data-slot="test-lab-monitor"><div class="section-head"><div><h2 id="test-runs-heading">Run monitor</h2><p class="muted">Scan every run here. Open one only when you need its preview, evidence, or controls.</p><div class="monitor-counts" aria-label="Run evidence summary"><span><b data-monitor-count="active">${e(activeRunCount)}</b> active</span><span><b data-monitor-count="provider">${e(awaitingProviderCount)}</b> awaiting provider</span><span><b data-monitor-count="phone">${e(awaitingPhoneCount)}</b> awaiting phone</span><span><b data-monitor-count="response">${e(awaitingResponseCount)}</b> awaiting response</span><span>${e(summary.activities)} total</span></div></div><div class="actions"><a class="button" href="${composerHref}" aria-controls="activity-builder-panel">New run</a><button class="destructive" data-workbench-action data-action="end-all-live-activities" data-confirm="Finish all ${e(activeRunCount)} active Test Lab run${activeRunCount === 1 ? "" : "s"}? This closes future mutations for every active dashboard-owned run."${finishAllDisabled}>Finish ${e(activeRunCount)} active</button></div></div><div class="workbench-layout" data-slot="test-lab-monitor-workspace"><div class="workbench-rail" aria-label="Test Lab runs"><div id="live-activity-feed" class="run-list">${activityRows()}</div>${activityPager}</div></div></section>${sessionPanel}${builderPanel}</div>`;
    const selected = (actual: string | undefined,value: string) => actual === value ? " selected" : "";
    const notificationFilters = `<form class="history-filters" method="get" action="/dashboard/inbox/notifications"><label>Kind<select name="kind"><option value="">All kinds</option>${dashboardNotificationKinds.map((value) => `<option value="${e(value)}"${selected(notificationKind,value)}>${e(value.replace("_"," "))}</option>`).join("")}</select></label><label>State<select name="state"><option value="">All states</option>${dashboardNotificationStates.map((value) => `<option value="${e(value)}"${selected(notificationState,value)}>${e(value)}</option>`).join("")}</select></label><button class="secondary" type="submit">Apply filters</button>${notificationKind || notificationState ? '<a class="button secondary" href="/dashboard/inbox/notifications">Clear</a>' : ""}</form>`;
    const notificationPager = renderDashboardPager({ path: "/dashboard/inbox/notifications", page: historyPage,
      pageSize: dashboardHistoryPageSize, total: summary.notification_history,
      query: { kind: notificationKind, state: notificationState } });
    const deliveryPager = renderDashboardPager({ path: "/dashboard/inbox/delivery", page: historyPage,
      pageSize: dashboardHistoryPageSize, total: summary.deliveries });
    const devicePager = renderDashboardPager({ path: "/dashboard/connections/phones", page: historyPage,
      pageSize: dashboardHistoryPageSize, total: summary.devices });
    const clientPager = renderDashboardPager({ path: "/dashboard/connections/clients", page: historyPage,
      pageSize: dashboardHistoryPageSize, total: summary.credentials });
    const servicePager = renderDashboardPager({ path: "/dashboard/connections/services", page: historyPage,
      pageSize: dashboardHistoryPageSize, total: summary.services });
    const approvalPager = renderDashboardPager({ path: "/dashboard", page: historyPage,
      pageSize: dashboardHistoryPageSize, total: summary.approvals });
    const inboxTabs = (active: "inbox" | "notifications" | "delivery") => renderDashboardTabs({ label: "Inbox", active, tabs: [
      { id: "inbox", label: "Inbox", href: "/dashboard", count: Number(summary.pending_responses)+Number(summary.approvals) },
      { id: "notifications", label: "Notifications", href: "/dashboard/inbox/notifications", count: Number(summary.notifications) },
      { id: "delivery", label: "Delivery", href: "/dashboard/inbox/delivery", count: Number(summary.deliveries) },
    ] });
    const connectionTabs = (active: "services" | "phones" | "clients") => renderDashboardTabs({ label: "Connections", active, tabs: [
      { id: "services", label: "Services & webhooks", href: "/dashboard/connections/services", count: Number(summary.services) },
      { id: "phones", label: "Registered phones", href: "/dashboard/connections/phones", count: Number(summary.devices) },
      { id: "clients", label: "CLI clients", href: "/dashboard/connections/clients", count: Number(summary.credentials) },
    ] });
    const sectionContent: Record<LegacyDashboardSection,string> = {
      inbox: `${inboxTabs("inbox")}<section class="card"><div class="section-head"><div><h2>Pending approvals</h2><p class="muted">Phone response requests and CLI connection requests waiting for an explicit owner decision.</p></div><span class="badge" data-state="pending">${e(Number(summary.pending_responses)+Number(summary.approvals))} pending</span></div><h3>Phone responses</h3>${pendingResponseRows}<h3 class="subsection-heading">CLI connection requests</h3>${approvalRows}${approvalPager}</section><section class="panel card"><div class="section-head"><div><h2>Recent notifications</h2><p class="muted">Newest durable events with source, target, state, timestamp, and canonical response.</p></div><a class="button secondary" href="/dashboard/inbox/notifications">View all</a></div>${notificationRows}</section>`,
      "inbox-notifications": `${inboxTabs("notifications")}<section class="card"><div class="section-head"><div><h2>Notification history</h2><p class="muted"><span data-snapshot-count="notifications">${e(summary.notifications)}</span> persistent events. Open an event without losing Inbox context.</p></div></div>${notificationFilters}${notificationRows}${notificationPager}</section>`,
      "inbox-delivery": `${inboxTabs("delivery")}<section class="card"><div class="section-head"><div><h2>Delivery attempts</h2><p class="muted"><span data-snapshot-count="deliveries">${e(summary.deliveries)}</span> durable target jobs with provider acceptance, retry, and terminal failure evidence.</p></div></div>${deliveryRows}${deliveryPager}</section>`,
      "connections-services": `${connectionTabs("services")}<section class="card"><div class="section-head"><div><h2>Services & secret webhooks</h2><p class="muted">Readiness and safe identity only. Raw secret URLs are never rendered; a newly issued value can only be copied once before it is cleared from browser memory.</p></div></div>${renderOneTimeServiceSecretPanel()}<form id="service-form" class="service-create-form"><label>Name<input name="title" maxlength="80" required placeholder="Service name"></label><label>Avatar image URL<input name="imageUrl" type="url" inputmode="url" placeholder="https://…"></label><label>Default tap URL<input name="destinationUrl" type="url" inputmode="url" placeholder="https://…"></label><button type="submit">Create service</button></form>${serviceRows}${servicePager}</section>`,
      "connections-phones": `${connectionTabs("phones")}<section class="card"><div class="section-head"><div><h2>Registered phones</h2><p class="muted"><span data-snapshot-count="devices">${e(summary.devices)}</span> active. Inspect notification and Live Activity readiness, identity, and last seen time.</p></div></div>${deviceRows}${devicePager}</section>`,
      "connections-clients": `${connectionTabs("clients")}<section class="card"><div class="section-head"><div><h2>CLI clients</h2><p class="muted">Scoped agent credentials with identity, scopes, expiry, last use, and revocation controls.</p></div></div>${credentialRows}${clientPager}</section>`,
      testing: workbench,
    };
    const headings: Record<LegacyDashboardSection,{ title: string; eyebrow: string; description: string }> = {
      inbox: { title: "Inbox", eyebrow: "Operate", description: `Account ${account.accountId}. Approvals and recent notification outcomes in one durable queue.` },
      "inbox-notifications": { title: "Notifications", eyebrow: "Inbox", description: "Review source, target, delivery state, timestamps, and canonical responses." },
      "inbox-delivery": { title: "Delivery", eyebrow: "Inbox", description: "Trace target-level server and provider attempts without inferring phone receipt." },
      "connections-services": { title: "Services & webhooks", eyebrow: "Connections", description: "Manage service identities and one-time secret webhook issuance safely." },
      "connections-phones": { title: "Registered phones", eyebrow: "Connections", description: "Inspect device identity, authorization readiness, and last seen state." },
      "connections-clients": { title: "CLI clients", eyebrow: "Connections", description: "Review scoped agent identities, expiry, use, and revocation." },
      testing: { title: "Live Activity Test Lab", eyebrow: "Testing", description: "Launch one bounded run per iPhone and distinguish server, provider, phone, and response evidence." },
    };
    context.header("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return context.html(renderDashboardDocument({
      active: section,
      ...headings[section],
      content: sectionContent[section],
      releaseIdentity,
      account: { initial, name, email },
    }));
  };
  app.get("/docs", (context) => context.redirect("/dashboard/docs"));
  app.get("/dashboard", inboxHandlers.overview);
  app.get("/dashboard/projects", projectHandlers.index);
  app.get("/dashboard/projects/:projectId", projectHandlers.detail);
  app.get("/dashboard/inbox", (context) => context.redirect("/dashboard",302));
  app.get("/dashboard/inbox/notifications", inboxHandlers.history);
  app.get("/dashboard/inbox/notifications/:notificationId", inboxHandlers.detail);
  app.get("/dashboard/inbox/delivery", inboxHandlers.delivery);
  app.get("/dashboard/connections", (context) => context.redirect("/dashboard/connections/services",302));
  app.get("/dashboard/connections/pairing", connectionsHandlers.pairing);
  app.get("/dashboard/connections/services", connectionsHandlers.services);
  app.get("/dashboard/connections/phones", connectionsHandlers.phones);
  app.get("/dashboard/connections/clients", connectionsHandlers.clients);
  app.get("/dashboard/testing", dashboardPage("testing"));
  app.get("/dashboard/testing/runs/:activityId/history", activityHistoryHandler);
  app.get("/dashboard/testing/runs/:activityId", dashboardPage("testing"));
  app.get("/dashboard/account", systemHandlers.account);
  app.get("/dashboard/docs", systemHandlers.docs);
  app.get("/dashboard/notifications", (context) => context.redirect("/dashboard/inbox/notifications",302));
  app.get("/dashboard/notifications/:notificationId", (context) => context.redirect(`/dashboard/inbox/notifications/${encodeURIComponent(context.req.param("notificationId"))}`,302));
  app.get("/dashboard/delivery", (context) => context.redirect("/dashboard/inbox/delivery",302));
  app.get("/dashboard/services", (context) => context.redirect("/dashboard/connections/services",302));
  app.get("/dashboard/devices", (context) => context.redirect("/dashboard/connections/phones",302));
  app.get("/dashboard/clients", (context) => context.redirect("/dashboard/connections/clients",302));
  app.get("/dashboard/approvals", (context) => context.redirect("/dashboard",302));

  app.patch("/api/dashboard/resources/projects/:projectId",projectHandlers.update);
  app.post("/api/dashboard/resources/projects/:projectId/aliases",projectHandlers.addAlias);
  app.delete("/api/dashboard/resources/projects/:projectId/aliases/:aliasId",projectHandlers.removeAlias);
  app.post("/api/dashboard/resources/projects/:projectId/merge",projectHandlers.merge);
  app.post("/api/dashboard/resources/projects/:projectId/split",projectHandlers.split);
  app.delete("/api/dashboard/resources/projects/:projectId",projectHandlers.archive);
  app.post("/api/dashboard/resources/projects/:projectId/restore",projectHandlers.restore);
}
