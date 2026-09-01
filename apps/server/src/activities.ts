import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { generateToken,hashToken } from "./auth.js";
import type { Database } from "./db.js";
import { internalId, publicId } from "./ids.js";
import { syncActivityPresentationLease } from "./activity-presentation-leases.js";
import {
  beginActivityTransaction,
  lifecycleMutationAllowed,
  resolveActivityReplay,
  resolveActivityByIdentifier,
  resolveActivitySelector,
  sameActivityTargets,
} from "./activity-lifecycle-domain.js";
import {
  recordActivityCorrelationDecision,
  recordActivityStartEvidence,
} from "./activity-relationships.js";
import {
  canonicalOriginHash,lockOriginGenerationSlot,originDescriptorSchema,originGenerationMetadata,
} from "./origin-slots.js";
import { registerPresentationRoutes } from "./presentation-assets.js";
import {
  PresentationRuntimeError,
  assertAccountPresentationAssets,
  canonicalPresentation,
  patchPresentationColumns,
  persistedPresentationColumns,
  presentationFromRow,
  presentationCommandProjection,
  terminalPresentationColumnsFromRow,
} from "./presentation-runtime.js";
import {
  ActivityPrivacyPolicyError,
  applyActivityPrivacyPolicy,
  loadClientPresentationPolicy,
  preserveActivePresentationPolicy,
  resolveActivityPresentation,
  systemPresentationPolicySnapshot,
} from "./presentation-policy.js";
import {
  agentLifecycleIdentitySchema,
  LIVE_ACTIVITY_PRESENTATION_PRESETS,
  liveActivityPresentationSchema,
} from "@relo/notification-contracts";

export const liveActivityStyles = [
  "standard", "hero", "terminal", "steps",
  "approval", "shell", "verdict", "signal",
] as const;
export const taskLiveActivityStyles = ["standard", "hero", "terminal", "steps"] as const;
export const liveActivitySymbols = ["terminal", "code", "build", "success", "warning"] as const;
const accentColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const DEFAULT_ACCENT_COLOR = "#5ED8B7";
const DEFAULT_EXPIRES_IN_SECONDS = 28_800;
const DEFAULT_STALE_AFTER_SECONDS = 14_400;

export function boundedPresentationText(value: string | undefined,maximum: number): string | undefined {
  if (!value) return undefined;
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  return `${characters.slice(0,maximum-1).join("").trimEnd()}…`;
}

const contextSchema = z.object({
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

const semanticStepsSchema = z.object({
  labels: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
  current: z.number().int().min(1).max(8),
}).strict().superRefine((value,context) => {
  if (value.current > value.labels.length) {
    context.addIssue({ code: "custom",path: ["current"],message: "Current step must reference a supplied label" });
  }
});

export const activityStartSchema = z.object({
  key: z.string().trim().min(1).max(100).optional(), replace: z.boolean().default(false),
  acquireMode: z.enum(["start","ensure"]).optional(),
  title: z.string().trim().min(1).max(80).optional(),
  status: z.string().trim().min(1).max(60).optional(), detail: z.string().trim().min(1).max(240).optional(),
  progress: z.number().min(0).max(1).optional(), symbol: z.enum(liveActivitySymbols).optional(),
  progressLabel: z.string().trim().min(1).max(32).optional(),
  steps: semanticStepsSchema.optional(),
  style: z.enum(taskLiveActivityStyles).optional(),
  preset: z.enum(LIVE_ACTIVITY_PRESENTATION_PRESETS).optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  accentColor: accentColorSchema.optional(),
  deviceIds: z.array(z.string()).min(1).max(50).optional(), context: contextSchema.optional(),
  origin: originDescriptorSchema.optional(),
  lifecycle: agentLifecycleIdentitySchema.optional(),
  expiresInSeconds: z.number().int().min(60).max(28_800).default(DEFAULT_EXPIRES_IN_SECONDS),
  staleAfterSeconds: z.number().int().min(0).max(28_800).default(DEFAULT_STALE_AFTER_SECONDS),
  presentation: liveActivityPresentationSchema.optional(),
}).strict().superRefine((value,context) => {
  if (value.lifecycle !== undefined && value.origin === undefined) {
    context.addIssue({ code: "custom",path: ["origin"],message: "Lifecycle acquisition requires an origin" });
  }
  if (!value.presentation && (!value.title || !value.status)) {
    context.addIssue({ code: "custom",message: "Semantic input requires title and status" });
  }
  if (value.presentation) {
    for (const key of ["title","status","detail","progress","progressLabel","steps"] as const) {
      if (value[key] !== undefined) {
        context.addIssue({ code: "custom",path: [key],message: "An explicit presentation uses the complete presentation record" });
      }
    }
  }
});

export const activityResolveSchema = z.object({
  origin: originDescriptorSchema.optional(),
  lifecycle: agentLifecycleIdentitySchema.optional(),
  current: z.literal(true).optional(),
}).strict().superRefine((value,context) => {
  const selectors = [value.origin,value.lifecycle,value.current].filter((part) => part !== undefined);
  if (selectors.length !== 1) {
    context.addIssue({ code: "custom",message: "Provide exactly one lifecycle resolver" });
  }
});

export const activityUpdateSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  status: z.string().trim().min(1).max(60).optional(),
  detail: z.string().trim().min(1).max(240).nullable().optional(),
  progress: z.number().min(0).max(1).nullable().optional(),
  progressLabel: z.string().trim().min(1).max(32).nullable().optional(),
  steps: semanticStepsSchema.optional(),
  symbol: z.enum(liveActivitySymbols).optional(),
  accentColor: accentColorSchema.optional(),
  style: z.enum(taskLiveActivityStyles).optional(),
  staleAfterSeconds: z.number().int().min(0).max(28_800).optional(),
  deliveryPriority: z.literal(10).optional(),
  context: contextSchema.optional(),
  lifecycle: agentLifecycleIdentitySchema.optional(),
  ifSequence: z.number().int().min(0).optional(),
  presentation: liveActivityPresentationSchema.optional(),
}).strict().refine(
  (value) => Object.entries(value).some(([key,part]) => !["ifSequence","lifecycle"].includes(key) && part !== undefined),
  "At least one activity field is required",
).superRefine((value,context) => {
  if (!value.presentation) return;
  for (const key of ["title","status","detail","progress","progressLabel","steps","symbol","accentColor","style"] as const) {
    if (value[key] !== undefined) {
      context.addIssue({ code: "custom",path: [key],message: "An explicit presentation replaces the complete presentation record" });
    }
  }
});

export const activityHeartbeatSchema = z.object({
  lifecycle: agentLifecycleIdentitySchema,
  leaseAfterSeconds: z.number().int().min(300).max(14_400).default(3_600),
}).strict();

export const activityEndSchema = z.object({
  status: z.string().trim().min(1).max(60).optional(),
  detail: z.string().trim().min(1).max(240).nullable().optional(),
  progress: z.number().min(0).max(1).nullable().optional(),
  symbol: z.enum(liveActivitySymbols).optional(),
  accentColor: accentColorSchema.optional(),
  dismissAfterSeconds: z.number().int().min(0).max(14400).default(0),
  ifSequence: z.number().int().min(0).optional(),
  lifecycle: agentLifecycleIdentitySchema.optional(),
  presentation: liveActivityPresentationSchema.optional(),
}).strict().superRefine((value,context) => {
  if (!value.presentation) return;
  for (const key of ["status","detail","progress","symbol","accentColor"] as const) {
    if (value[key] !== undefined) {
      context.addIssue({ code: "custom",path: [key],message: "An explicit presentation replaces the complete presentation record" });
    }
  }
});

const activityWaitLabelSchema = z.string().trim().min(1).max(24)
  .refine((value) => !/[\r\n]/.test(value),"Action labels must use one line");

export const activityWaitSchema = z.object({
  type: z.enum(["approval","yes-no","yes_no","text"])
    .transform((value) => value === "yes-no" ? "yes_no" as const : value),
  prompt: z.string().trim().min(1).max(2_000),
  expiresInSeconds: z.number().int().min(30).max(28_800).default(900),
  primaryLabel: activityWaitLabelSchema.optional(),
  secondaryLabel: activityWaitLabelSchema.optional(),
}).strict().superRefine((input,context) => {
  if (input.type !== "text" && input.prompt.length > 240) {
    context.addIssue({ code: "custom",path: ["prompt"],message: "Live Activity prompts are limited to 240 characters" });
  }
  if (input.type === "text" && (input.primaryLabel !== undefined || input.secondaryLabel !== undefined)) {
    context.addIssue({ code: "custom",message: "Text waits do not accept Live Activity action labels" });
  }
});

export const activityDeliverySummarySchema = z.object({
  eligibleDevices: z.number().int().min(0),
  durableCommands: z.number().int().min(0),
  apnsJobs: z.number().int().min(0),
}).strict();

export type ActivityDeliverySummary = z.infer<typeof activityDeliverySummarySchema>;
export type ApnsMode = "disabled" | "production" | "sandbox";
type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };
type EligibleDevice = {
  id: string;
  apns_token: string | null;
  apns_environment: "production" | "sandbox";
  live_activity_push_to_start_token: string | null;
  live_activity_authorization: string;
  notification_authorization: string;
  revoked_at: Date | null;
};

export function serializeTaskActivity(row: any) {
  const presentation = presentationFromRow(row);
  const presentationHash = row.presentation_sha256
    ?? persistedPresentationColumns(presentation).presentationHash;
  return {
    id: publicId("act",row.id), generation: Number(row.generation ?? 1),
    ownerKind: row.lifecycle_provider && row.lifecycle_run_id
      ? "provider_run"
      : row.requester_service_id
        ? "service_run"
        : row.requester_credential_id
          ? row.activity_key ? "manual_key" : "credential_session"
          : "dashboard_test",
    key: row.activity_key ?? null, title: row.title,
    status: row.status, detail: row.detail, progress: row.progress,
    symbol: row.symbol ?? "terminal", style: row.style ?? "standard",
    privacy: row.privacy, privacyMode: row.privacy,
    accentColor: row.accent_color ?? DEFAULT_ACCENT_COLOR, state: row.state,
    sequence: Number(row.sequence), createdAt: row.created_at,
    expiresAt: row.expires_at, staleAt: row.stale_at,
    updatedAt: row.updated_at, endedAt: row.ended_at,
    terminalReason: row.terminal_reason ?? null,
    terminalActor: row.terminal_actor ?? null,
    terminalPolicy: row.terminal_policy ?? null,
    terminalTransitionAt: row.terminal_transition_at ?? null,
    context: row.context ?? null,
    originThreadId: row.origin_hash ?? null,
    lifecycle: row.lifecycle_provider && row.lifecycle_run_id
      ? { provider: row.lifecycle_provider,runId: row.lifecycle_run_id }
      : null,
    presentation,
    presentationHash,
    presentationPresetId: row.presentation_preset_id ?? row.presentation_policy?.presetId ?? null,
    presentationPresetRevision: row.presentation_preset_revision
      ?? row.presentation_policy?.presetRevision ?? null,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string,unknown>)
      .sort(([left],[right]) => left.localeCompare(right))
      .map(([key,item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function taskActivityRequestHash(operation: string, value: unknown): string {
  return createHash("sha256")
    .update(`relo:live-activity:${operation}\n${stableJson(value)}`)
    .digest("hex");
}

function idempotencyKey(value: string | undefined): string | undefined {
  return value === undefined ? undefined : z.string().trim().min(1).max(200).parse(value);
}

function requiredIdempotencyKey(value: string | undefined): string | null {
  return value === undefined ? null : z.string().trim().min(1).max(200).parse(value);
}

function internalDeviceIds(values: string[] | undefined): string[] | null {
  if (!values) return null;
  const ids = values.map((value) => internalId("dev",value));
  if (ids.some((value) => !value || !z.uuid().safeParse(value).success)) return [];
  const unique = [...new Set(ids as string[])];
  return unique.length === ids.length ? unique : [];
}

async function eligibleDevices(
  query: Queryable,
  principalId: string,
  requestedIds: string[] | null,
): Promise<EligibleDevice[]> {
  const result = await query.query(
    `SELECT id,apns_token,apns_environment,live_activity_push_to_start_token,
       live_activity_authorization,notification_authorization,revoked_at FROM devices
     WHERE principal_id=$1 AND revoked_at IS NULL AND live_activity_authorization='authorized'
       AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[]))
     ORDER BY id`,
    [principalId,requestedIds],
  );
  return result.rows;
}

async function immutableActivityTargets(
  query: Queryable,
  principalId: string,
  targetIds: string[],
): Promise<EligibleDevice[]> {
  if (!targetIds.length) return [];
  const result = await query.query(
    `SELECT id,apns_token,apns_environment,live_activity_push_to_start_token,
       live_activity_authorization,notification_authorization,revoked_at FROM devices
     WHERE principal_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
    [principalId,targetIds],
  );
  return result.rows;
}

export async function cancelPendingActivityInteractions(
  query: Queryable,
  principalId: string,
  activityId: string,
): Promise<number> {
  const canceled = await query.query(
    `UPDATE interaction_requests r SET state='canceled',responded_at=now()
     FROM notification_events e
     WHERE r.notification_event_id=e.id AND r.state='pending'
       AND e.principal_id=$1 AND e.payload#>>'{liveActivity,activityId}'=$2
     RETURNING e.id`,
    [principalId,publicId("act",activityId)],
  );
  const eventIds = canceled.rows.map((row: { id: string }) => row.id);
  if (eventIds.length) {
    await query.query(
      "UPDATE notification_events SET state='canceled',updated_at=now() WHERE id=ANY($1::uuid[])",
      [eventIds],
    );
  }
  return eventIds.length;
}

export function activityProviderTimestamp(activity: {
  created_at: Date | string;
  updated_at?: Date | string | null;
  sequence: number | string;
}): number {
  const created = Math.floor(new Date(activity.created_at).getTime()/1_000);
  const updated = activity.updated_at == null
    ? created
    : Math.floor(new Date(activity.updated_at).getTime()/1_000);
  const sequence = Number(activity.sequence);
  if (!Number.isSafeInteger(created) || created < 0
    || !Number.isSafeInteger(updated) || updated < 0
    || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("invalid durable Live Activity chronology");
  }
  return Math.max(updated,created+sequence);
}

export async function createActivityCommands(
  query: Queryable,
  input: {
    principalId: string;
    sourceName: string;
    activity: any;
    operation: "start" | "update" | "end";
    apnsMode: ApnsMode;
    dismissAfterSeconds?: number | null;
    priority?: 5 | 10;
    requestedDeviceIds?: string[] | null;
  },
): Promise<ActivityDeliverySummary> {
  const targetIds = input.requestedDeviceIds ?? input.activity.target_device_ids;
  const devices = targetIds === null || targetIds === undefined
    ? await eligibleDevices(query,input.principalId,null)
    : await immutableActivityTargets(query,input.principalId,targetIds);
  const canonical = presentationFromRow(input.activity);
  const canonicalColumns = persistedPresentationColumns(canonical);
  let durableCommands = 0;
  let apnsJobs = 0;
  for (const device of devices) {
    const lease = await syncActivityPresentationLease(query,{
      principalId: input.principalId,
      activity: input.activity,
      deviceId: device.id,
      operation: input.operation,
    });
    const command = presentationCommandProjection(canonical);
    const remoteActivityEligible = input.apnsMode !== "disabled"
      && device.apns_environment === input.apnsMode
      && !device.revoked_at
      && device.live_activity_authorization === "authorized";
    const transport = input.operation === "start" || lease.restartRequired
      ? (remoteActivityEligible && device.live_activity_push_to_start_token ? "live_activity_start" : null)
      : (remoteActivityEligible ? "live_activity_update" : null);
    const apnsOwnsStartAlert = transport === "live_activity_start";
    const eventKey = `activity:${input.activity.id}:${input.activity.sequence}:${input.operation}:${device.id}`;
    let event = await query.query(
      `INSERT INTO notification_events(
         principal_id,requester_credential_id,requester_service_id,source,kind,title,body,payload,
         idempotency_key,target_mode,expires_at,origin_hash
       ) VALUES ($1,$2,$3,$4,'live_activity',$5,$6,$7,$8,'explicit',$9,$10)
      ON CONFLICT DO NOTHING RETURNING id,payload`,
      [input.principalId,input.activity.requester_credential_id ?? null,
        input.activity.requester_service_id ?? null,input.sourceName,canonical.content.title,
        canonical.content.subtitle ?? "",{
        ...(input.activity.context ? { context: input.activity.context } : {}),
        privacy: canonical.privacy,
        liveActivity: {
          operation: input.operation,
          activityId: publicId("act",input.activity.id),
          generation: Number(input.activity.generation),
          targetDeviceId: publicId("dev",device.id),
          ...command,
          style: canonicalColumns.style,
          sourceName: input.sourceName,
          privacy: canonical.privacy,
          expiresAt: input.activity.expires_at ?? null,
          staleAt: input.activity.stale_at ?? null,
          alertOwner: apnsOwnsStartAlert ? "apns" : input.operation === "start" ? "app" : "none",
          sequence: Number(input.activity.sequence),
          providerTimestamp: activityProviderTimestamp(input.activity),
          relevanceScore: lease.relevanceScore,
          presentationState: lease.state,
          otherActiveCount: lease.otherActiveCount,
          priority: 10,
          dismissAfterSeconds: input.dismissAfterSeconds ?? null,
          interaction: null,
        },
      },eventKey,input.operation === "end"
        ? new Date(Date.now()+3_600_000)
        : (input.activity.expires_at ?? null),input.activity.origin_hash ?? null],
    );
    if (!event.rowCount) {
      event = await query.query(
        `SELECT id,payload FROM notification_events WHERE principal_id=$1 AND idempotency_key=$2
         AND requester_credential_id IS NOT DISTINCT FROM $3::uuid
         AND requester_service_id IS NOT DISTINCT FROM $4::uuid`,
        [input.principalId,eventKey,input.activity.requester_credential_id ?? null,
          input.activity.requester_service_id ?? null],
      );
    }
    if (!event.rowCount) throw new Error("activity command persistence failed");
    await query.query(
      `INSERT INTO notification_event_targets(notification_event_id,device_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [event.rows[0]!.id,device.id],
    );
    if (canonical.behavior.type === "approval" || canonical.behavior.type === "yes_no") {
      await query.query(
        `INSERT INTO interaction_requests(
           principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (notification_event_id) DO NOTHING`,
        [input.principalId,event.rows[0]!.id,canonical.behavior.type,
          canonical.content.subtitle ?? canonical.content.status,
          hashToken(generateToken()),input.activity.expires_at ?? new Date(Date.now()+900_000)],
      );
    }
    durableCommands += 1;
    if (!transport) continue;
    await query.query(
      `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (notification_event_id,device_id) DO NOTHING`,
      [event.rows[0]!.id,device.id,transport,input.activity.id],
    );
    const job = await query.query(
      "SELECT 1 FROM delivery_jobs WHERE notification_event_id=$1 AND device_id=$2",
      [event.rows[0]!.id,device.id],
    );
    apnsJobs += job.rowCount ? 1 : 0;
  }
  return { eligibleDevices: devices.length, durableCommands, apnsJobs };
}

async function cleanupUndeliverableTerminalTokens(query: Queryable, activityId: string): Promise<void> {
  await query.query(
    `DELETE FROM live_activity_update_tokens t
     WHERE t.live_activity_id=$1 AND NOT EXISTS (
       SELECT 1 FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
       WHERE j.live_activity_id=t.live_activity_id AND j.device_id=t.device_id
         AND j.transport='live_activity_update'
         AND e.payload#>>'{liveActivity,operation}'='end'
     )`,
    [activityId],
  );
}

const activityReplay = (
  query: Queryable,
  principalId: string,
  requesterCredentialId: string,
  key: string | undefined,
  operation: "update" | "end",
  hash: string,
) => resolveActivityReplay(query,{
  principalId,credentialId: requesterCredentialId,serviceId: null,
},key,operation,hash,(delivery) => activityDeliverySummarySchema.parse(delivery));

export async function resolveOwnedActivity(
  query: Queryable,
  principalId: string,
  identifier: string,
  forUpdate = false,
  requesterCredentialId?: string,
): Promise<any | undefined> {
  if (!requesterCredentialId) return undefined;
  return resolveActivityByIdentifier(query,{
    principalId,credentialId: requesterCredentialId,serviceId: null,
  },identifier,forUpdate);
}

async function resolveCurrentOwnedActivity(
  query: Queryable,
  principalId: string,
  requesterCredentialId: string,
  forUpdate = false,
): Promise<{ activity?: any; ambiguous: boolean }> {
  return resolveActivitySelector(query,{
    principalId,credentialId: requesterCredentialId,serviceId: null,
  },{ current: true },forUpdate);
}

async function resolveMutationActivity(
  query: Queryable,
  principalId: string,
  requesterCredentialId: string,
  identifier: string,
  forUpdate = false,
): Promise<{ activity?: any; ambiguous: boolean }> {
  if (identifier === "current") {
    return resolveCurrentOwnedActivity(query,principalId,requesterCredentialId,forUpdate);
  }
  return {
    activity: await resolveOwnedActivity(
      query,principalId,identifier,forUpdate,requesterCredentialId,
    ),
    ambiguous: false,
  };
}

async function recordTerminalOperation(
  query: Queryable,
  input: {
    principalId: string;
    sourceName: string;
    activity: any;
    state: "expired" | "replaced";
    apnsMode: ApnsMode;
  },
): Promise<void> {
  await cancelPendingActivityInteractions(query,input.principalId,input.activity.id);
  const delivery = await createActivityCommands(query,{
    principalId: input.principalId,
    sourceName: input.sourceName,
    activity: input.activity,
    operation: "end",
    apnsMode: input.apnsMode,
    dismissAfterSeconds: 0,
  });
  await cleanupUndeliverableTerminalTokens(query,input.activity.id);
  const snapshot = serializeTaskActivity(input.activity);
  await query.query(
    `INSERT INTO live_activity_operations(
       live_activity_id,principal_id,requester_service_id,requester_credential_id,
       idempotency_key,operation,resulting_sequence,request_hash,
       delivery_summary,dismiss_after_seconds,activity_snapshot
     ) VALUES ($1,$2,$3,$4,$5,'end',$6,$7,$8,0,$9)`,
    [input.activity.id,input.principalId,input.activity.requester_service_id ?? null,
      input.activity.requester_credential_id ?? null,`server:${input.state}:${randomUUID()}`,input.activity.sequence,
      taskActivityRequestHash(input.state,{ activityId: publicId("act",input.activity.id), sequence: Number(input.activity.sequence) }),
      delivery,snapshot],
  );
}

async function expireLockedRows(
  query: Queryable,
  rows: any[],
  apnsMode: ApnsMode,
): Promise<number> {
  let expired = 0;
  for (const current of rows) {
    const stored = terminalPresentationColumnsFromRow(current,"Expired","warning");
    const ended = (await query.query(
      `UPDATE live_activities SET state='expired',title=$2,status=$3,detail=$4,progress=$5,
         symbol=$6,privacy=$7,accent_color=$8,style=$9,presentation=$10,presentation_sha256=$11,
         terminal_reason=CASE WHEN expires_at<=now() THEN 'absolute_expiry' ELSE 'inactivity_timeout' END,
         terminal_actor='server',terminal_policy='lifecycle_reconciler',terminal_transition_at=now(),
         sequence=sequence+1,ended_at=now(),updated_at=now()
       WHERE id=$1 AND state='active' RETURNING *`,
      [current.id,stored.title,stored.status,stored.detail,stored.progress,stored.symbol,
        stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash],
    )).rows[0];
    if (!ended) continue;
    await recordTerminalOperation(query,{
      principalId: ended.principal_id,
      sourceName: "Relo Lifecycle",
      activity: ended,
      state: "expired",
      apnsMode,
    });
    expired += 1;
  }
  return expired;
}

export async function expireDueActivities(
  db: Database,
  apnsMode: ApnsMode,
  limit = 50,
): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<any>(
      `SELECT * FROM live_activities
       WHERE state='active'
         AND (expires_at<=now() OR (lifecycle_provider IS NOT NULL AND stale_at<=now()))
         AND presentation IS NOT NULL
       ORDER BY LEAST(expires_at,stale_at) FOR UPDATE SKIP LOCKED LIMIT $1`,
      [limit],
    );
    await expireLockedRows(client,due.rows,apnsMode);
    await client.query("COMMIT");
    return due.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceBlockingTaskActivities(
  query: Queryable,
  input: {
    principalId: string;
    sourceName: string;
    blockerIds: string[];
    apnsMode: ApnsMode;
  },
): Promise<number> {
  if (!input.blockerIds.length) return 0;
  const blockers = await query.query(
    `SELECT * FROM live_activities
     WHERE principal_id=$1 AND id=ANY($2::uuid[]) AND state='active'
       AND presentation IS NOT NULL
     ORDER BY created_at FOR UPDATE`,
    [input.principalId,input.blockerIds],
  );
  for (const blocker of blockers.rows) {
    const stored = terminalPresentationColumnsFromRow(blocker,"Replaced","warning");
    const ended = (await query.query(
      `UPDATE live_activities SET state='replaced',title=$2,status=$3,detail=$4,progress=$5,
         symbol=$6,privacy=$7,accent_color=$8,style=$9,presentation=$10,presentation_sha256=$11,
         terminal_reason='explicit_replace',terminal_actor='producer',
         terminal_policy='replacement',terminal_transition_at=now(),
         sequence=sequence+1,ended_at=now(),updated_at=now()
       WHERE id=$1 AND state='active' RETURNING *`,
      [blocker.id,stored.title,stored.status,stored.detail,stored.progress,stored.symbol,
        stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash],
    )).rows[0];
    if (ended) await recordTerminalOperation(query,{
      principalId: input.principalId,
      sourceName: input.sourceName,
      activity: ended,
      state: "replaced",
      apnsMode: input.apnsMode,
    });
  }
  return blockers.rows.length;
}

type ActivityWaitReplayRow = {
  request_hash: string | null;
  delivery_summary: ActivityDeliverySummary;
  companion_activity_id: string | null;
  event_id: string;
  interaction_id: string;
  interaction_kind: "approval" | "yes_no" | "text";
  interaction_prompt: string;
  interaction_state: string;
  interaction_expires_at: Date;
};

async function activityWaitReplay(
  query: Queryable,
  principalId: string,
  credentialId: string,
  activityId: string,
  key: string,
): Promise<ActivityWaitReplayRow | undefined> {
  return (await query.query(
    `SELECT o.request_hash,o.delivery_summary,o.companion_activity_id,
       e.id AS event_id,r.id AS interaction_id,r.kind AS interaction_kind,
       r.prompt AS interaction_prompt,r.state AS interaction_state,r.expires_at AS interaction_expires_at
     FROM live_activity_operations o
     JOIN notification_events e ON e.principal_id=o.principal_id
       AND e.requester_credential_id=o.requester_credential_id AND e.idempotency_key=o.idempotency_key
     JOIN interaction_requests r ON r.notification_event_id=e.id
     WHERE o.live_activity_id=$1 AND o.principal_id=$2 AND o.requester_credential_id=$3
       AND o.requester_service_id IS NULL AND o.operation='wait' AND o.idempotency_key=$4`,
    [activityId,principalId,credentialId,key],
  )).rows[0];
}

function activityWaitResponse(
  row: ActivityWaitReplayRow,
  parentActivityId: string,
  apnsMode: ApnsMode,
  replayed: boolean,
) {
  const delivery = activityDeliverySummarySchema.parse(row.delivery_summary);
  const eventId = publicId("ntf",row.event_id);
  return {
    parentActivityId,
    companionActivityId: row.companion_activity_id ? publicId("act",row.companion_activity_id) : null,
    interaction: {
      id: publicId("int",row.interaction_id),eventId,type: row.interaction_kind,
      prompt: row.interaction_prompt,state: row.interaction_state,
      expiresAt: new Date(row.interaction_expires_at).toISOString(),
    },
    eventId,delivery,queued: delivery.apnsJobs,
    deliveryMode: apnsMode !== "disabled" && delivery.apnsJobs > 0
      ? "queued_for_direct_apns"
      : "durable_inbox_refresh_only",
    replayed,
  };
}

export function registerActivityRoutes(app: Hono, db: Database, apnsMode: ApnsMode): void {
  registerPresentationRoutes(app,db);

  app.post("/api/live-activities", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:write")) return context.json({ error: "forbidden" },403);
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const rawInput = activityStartSchema.parse(await context.req.json());
    const effectivePolicy = await loadClientPresentationPolicy(
      db,auth.principalId,auth.credentialId,
    );
    let storedPresentation: ReturnType<typeof persistedPresentationColumns>;
    let presentationPolicy: ReturnType<typeof resolveActivityPresentation>["snapshot"];
    try {
      const resolved = resolveActivityPresentation(rawInput,{
        principalId: auth.principalId,effective: effectivePolicy,
      });
      storedPresentation = resolved.stored;
      presentationPolicy = resolved.snapshot;
    } catch (error) {
      if (error instanceof ActivityPrivacyPolicyError) return context.json({ error: error.code },409);
      if (error instanceof PresentationRuntimeError) return context.json({ error: error.code },400);
      throw error;
    }
    const input = { ...rawInput,
      title: storedPresentation.title,status: storedPresentation.status,detail: storedPresentation.detail,
      progress: storedPresentation.progress,symbol: storedPresentation.symbol,style: storedPresentation.style,
      privacy: storedPresentation.privacy,privacyMode: storedPresentation.privacy,
      accentColor: storedPresentation.accentColor,presentation: storedPresentation.presentation };
    const key = idempotencyKey(context.req.header("idempotency-key"));
    const requestedIds = internalDeviceIds(input.deviceIds);
    if (input.deviceIds && !requestedIds?.length) return context.json({ error: "invalid_device_selection" },400);
    const hash = taskActivityRequestHash("start",{
      ...rawInput,
      deviceIds: rawInput.deviceIds ? [...rawInput.deviceIds].sort() : undefined,
    });
    const originHash = input.origin ? canonicalOriginHash(auth.principalId,input.origin) : null;

    const existing = key ? await db.query<any>(
      `SELECT * FROM live_activities WHERE principal_id=$1 AND requester_service_id IS NULL
         AND (requester_credential_id=$2 OR requester_credential_id IS NULL)
         AND start_idempotency_key=$3 ORDER BY (requester_credential_id=$2) DESC LIMIT 1`,
      [auth.principalId,auth.credentialId,key],
    ) : undefined;
    if (existing?.rowCount) {
      const row = existing.rows[0]!;
      if (row.requester_credential_id !== auth.credentialId) {
        return context.json({ error: "idempotency_conflict" },409);
      }
      if (!row.start_request_hash || row.start_request_hash !== hash || !row.start_snapshot) {
        return context.json({ error: "idempotency_conflict" },409);
      }
      const delivery = activityDeliverySummarySchema.parse(row.start_delivery_summary);
      return context.json({ activity: row.start_snapshot, delivery, queued: delivery.apnsJobs,
        disposition: "replayed",replayed: true,...originGenerationMetadata(row,false),
        ...(row.start_replace_requested ? { replaced: row.start_replaced_count } : {}) });
    }
    const originReplay = originHash
      ? await activityReplay(db,auth.principalId,auth.credentialId,key,"update",hash)
      : null;
    if (originReplay?.conflict) return context.json({ error: "idempotency_conflict" },409);
    if (originReplay?.snapshot && originReplay.delivery) {
      return context.json({ activity: originReplay.snapshot,delivery: originReplay.delivery,
        queued: originReplay.delivery.apnsJobs,disposition: "replayed",
        replayed: true,reused: true,resumed: false });
    }

    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      await assertAccountPresentationAssets(client,auth.principalId,input.presentation);
      const expireDue = async () => {
        const due = await client.query<any>(
          `SELECT * FROM live_activities WHERE principal_id=$1 AND state='active' AND expires_at<=now()
             AND presentation IS NOT NULL
           ORDER BY expires_at FOR UPDATE`,
          [auth.principalId],
        );
        await expireLockedRows(client,due.rows,apnsMode);
      };
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",[auth.principalId]);
      await expireDue();
      const originSlot = originHash
        ? await lockOriginGenerationSlot(client,auth.principalId,originHash)
        : null;
      const devices = await eligibleDevices(client,auth.principalId,requestedIds);
      if (requestedIds && devices.length !== requestedIds.length) {
        await transaction.rollback();
        return context.json({ error: "invalid_device_selection" },400);
      }
      const blockers = await client.query<any>(
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
        return context.json({ error: "active_origin_conflict",code: "ACTIVE_ORIGIN_CONFLICT" },409);
      }
      const requestedTargets = devices.map((device) => device.id).sort();
      const convergenceCandidates = blockers.rows.filter((row: any) =>
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
          return context.json({ error: "activity_selection_ambiguous",
            code: "ACTIVITY_SELECTION_AMBIGUOUS",disposition: "blocked" },409);
        }
        const current = convergenceCandidates[0]!;
        if (input.key && blockers.rows.some((row: any) => row.id !== current.id
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
          return context.json({ error: "owner_target_conflict",code: "OWNER_TARGET_CONFLICT",
            disposition: "blocked" },409);
        }
        const concurrentReplay = await activityReplay(
          client,auth.principalId,auth.credentialId,key,"update",hash,
        );
        if (concurrentReplay?.conflict) {
          await transaction.rollback();
          return context.json({ error: "idempotency_conflict" },409);
        }
        if (concurrentReplay?.snapshot && concurrentReplay.delivery) {
          await transaction.commit();
          return context.json({ activity: concurrentReplay.snapshot,delivery: concurrentReplay.delivery,
            queued: concurrentReplay.delivery.apnsJobs,disposition: "replayed",
            replayed: true,reused: true,resumed: Boolean(originHash) });
        }
        const activePresentation = preserveActivePresentationPolicy(
          current,rawInput,storedPresentation,
        );
        const updated = await client.query<any>(
          `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
             privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
             context=COALESCE($13::jsonb,context),stale_at=LEAST(now()+($14*interval '1 second'),expires_at),
             origin_hash=COALESCE(origin_hash,$15),
             lifecycle_provider=COALESCE(lifecycle_provider,$16),
             lifecycle_run_id=COALESCE(lifecycle_run_id,$17),
             activity_key=COALESCE(activity_key,$19),
             presentation_policy_source=COALESCE(presentation_policy_source,$20),
             presentation_preset_id=COALESCE(presentation_preset_id,$21),
             presentation_preset_revision=COALESCE(presentation_preset_revision,$22),
             sequence=sequence+1,updated_at=now()
           WHERE id=$1 AND principal_id=$2 AND state='active'
             AND requester_credential_id=$18 AND requester_service_id IS NULL RETURNING *`,
          [current.id,auth.principalId,activePresentation.title,activePresentation.status,
            activePresentation.detail,activePresentation.progress,activePresentation.symbol,
            activePresentation.style,activePresentation.privacy,activePresentation.accentColor,
            activePresentation.presentation,activePresentation.presentationHash,
            input.context ?? null,input.staleAfterSeconds,originHash,
            input.lifecycle?.provider ?? null,input.lifecycle?.runId ?? null,auth.credentialId,
            input.key ?? null,current.presentation_policy_source,
            current.presentation_preset_id,current.presentation_preset_revision],
        );
        await cancelPendingActivityInteractions(client,auth.principalId,current.id);
        const delivery = await createActivityCommands(client,{
          principalId: auth.principalId,sourceName: auth.clientName ?? "Relo CLI",
          activity: updated.rows[0],operation: "update",apnsMode,
        });
        const snapshot = serializeTaskActivity(updated.rows[0]);
        await client.query(
          `INSERT INTO live_activity_operations(
             live_activity_id,principal_id,requester_credential_id,idempotency_key,operation,
             resulting_sequence,request_hash,delivery_summary,activity_snapshot
           ) VALUES ($1,$2,$3,$4,'update',$5,$6,$7,$8)`,
          [current.id,auth.principalId,auth.credentialId,key ?? `server:${randomUUID()}`,
            updated.rows[0].sequence,hash,delivery,snapshot],
        );
        await recordActivityCorrelationDecision(client,{
          principalId: auth.principalId,
          activityId: current.id,
          outcome: "reused",
          matchedBy: originHash ? "origin" : "current",
          actor: "cli",
          reason: originHash ? "manual_activity_adopted_by_origin" : "single_current_activity",
        });
        await transaction.commit();
        return context.json({ activity: snapshot,delivery,queued: delivery.apnsJobs,
          disposition: "reused",replayed: false,reused: true,resumed: Boolean(originHash) });
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
          return context.json({ error: "active_origin_run_conflict",code: "ACTIVE_ORIGIN_RUN_CONFLICT",
            activityId: publicId("act",current.id) },409);
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
          return context.json({ error: "origin_target_conflict",code: "ORIGIN_TARGET_CONFLICT",
            activityId: publicId("act",current.id) },409);
        }
        const concurrentReplay = await activityReplay(
          client,auth.principalId,auth.credentialId,key,"update",hash,
        );
        if (concurrentReplay?.conflict) {
          await transaction.rollback();
          return context.json({ error: "idempotency_conflict" },409);
        }
        if (concurrentReplay?.snapshot && concurrentReplay.delivery) {
          await transaction.commit();
          return context.json({ activity: concurrentReplay.snapshot,delivery: concurrentReplay.delivery,
            queued: concurrentReplay.delivery.apnsJobs,disposition: "replayed",
            replayed: true,reused: true,resumed: false });
        }
        const activePresentation = preserveActivePresentationPolicy(
          current,rawInput,storedPresentation,
        );
        const updated = await client.query<any>(
          `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
             privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
             context=COALESCE($13::jsonb,context),stale_at=LEAST(now()+($14*interval '1 second'),expires_at),
             lifecycle_provider=COALESCE(lifecycle_provider,$15),
             lifecycle_run_id=COALESCE(lifecycle_run_id,$16),
             presentation_policy_source=COALESCE(presentation_policy_source,$17),
             presentation_preset_id=COALESCE(presentation_preset_id,$18),
             presentation_preset_revision=COALESCE(presentation_preset_revision,$19),
             sequence=sequence+1,updated_at=now()
           WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
          [current.id,auth.principalId,activePresentation.title,activePresentation.status,
            activePresentation.detail,activePresentation.progress,activePresentation.symbol,
            activePresentation.style,activePresentation.privacy,activePresentation.accentColor,
            activePresentation.presentation,activePresentation.presentationHash,
            input.context ?? null,input.staleAfterSeconds,
            input.lifecycle?.provider ?? null,input.lifecycle?.runId ?? null,
            current.presentation_policy_source,
            current.presentation_preset_id,current.presentation_preset_revision],
        );
        await cancelPendingActivityInteractions(client,auth.principalId,current.id);
        const delivery = await createActivityCommands(client,{
          principalId: auth.principalId,sourceName: auth.clientName ?? "Relo CLI",
          activity: updated.rows[0],operation: "update",apnsMode,
        });
        const snapshot = serializeTaskActivity(updated.rows[0]);
        await client.query(
          `INSERT INTO live_activity_operations(
             live_activity_id,principal_id,requester_credential_id,idempotency_key,operation,
             resulting_sequence,request_hash,delivery_summary,activity_snapshot
           ) VALUES ($1,$2,$3,$4,'update',$5,$6,$7,$8)`,
          [current.id,auth.principalId,auth.credentialId,key ?? `server:${randomUUID()}`,
            updated.rows[0].sequence,hash,delivery,snapshot],
        );
        await recordActivityCorrelationDecision(client,{
          principalId: auth.principalId,
          activityId: current.id,
          outcome: "reused",
          matchedBy: input.lifecycle ? "lifecycle" : "origin",
          actor: "cli",
          reason: input.lifecycle ? "active_lifecycle_match" : "active_origin_match",
        });
        await transaction.commit();
        return context.json({ activity: snapshot,delivery,queued: delivery.apnsJobs,
          disposition: "reused",replayed: false,reused: true,resumed: false });
      }
      if (!originHash && input.acquireMode === "ensure" && input.key) {
        const current = blockers.rows.find((row: any) => row.activity_key === input.key
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
            return context.json({ error: "owner_target_conflict",code: "OWNER_TARGET_CONFLICT",
              disposition: "blocked" },409);
          }
          const concurrentReplay = await activityReplay(
            client,auth.principalId,auth.credentialId,key,"update",hash,
          );
          if (concurrentReplay?.conflict) {
            await transaction.rollback();
            return context.json({ error: "idempotency_conflict" },409);
          }
          if (concurrentReplay?.snapshot && concurrentReplay.delivery) {
            await transaction.commit();
            return context.json({ activity: concurrentReplay.snapshot,delivery: concurrentReplay.delivery,
              queued: concurrentReplay.delivery.apnsJobs,disposition: "replayed",
              replayed: true,reused: true,resumed: false });
          }
          const activePresentation = preserveActivePresentationPolicy(
            current,rawInput,storedPresentation,
          );
          const updated = await client.query<any>(
            `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
               privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
               context=COALESCE($13::jsonb,context),stale_at=LEAST(now()+($14*interval '1 second'),expires_at),
               presentation_policy_source=COALESCE(presentation_policy_source,$15),
               presentation_preset_id=COALESCE(presentation_preset_id,$16),
               presentation_preset_revision=COALESCE(presentation_preset_revision,$17),
               sequence=sequence+1,updated_at=now()
             WHERE id=$1 AND principal_id=$2 AND state='active'
               AND lifecycle_provider IS NULL AND lifecycle_run_id IS NULL RETURNING *`,
            [current.id,auth.principalId,activePresentation.title,activePresentation.status,
              activePresentation.detail,activePresentation.progress,activePresentation.symbol,
              activePresentation.style,activePresentation.privacy,activePresentation.accentColor,
              activePresentation.presentation,activePresentation.presentationHash,
              input.context ?? null,input.staleAfterSeconds,
              current.presentation_policy_source,
              current.presentation_preset_id,current.presentation_preset_revision],
          );
          await cancelPendingActivityInteractions(client,auth.principalId,current.id);
          const delivery = await createActivityCommands(client,{
            principalId: auth.principalId,sourceName: auth.clientName ?? "Relo CLI",
            activity: updated.rows[0],operation: "update",apnsMode,
          });
          const snapshot = serializeTaskActivity(updated.rows[0]);
          await client.query(
            `INSERT INTO live_activity_operations(
               live_activity_id,principal_id,requester_credential_id,idempotency_key,operation,
               resulting_sequence,request_hash,delivery_summary,activity_snapshot
             ) VALUES ($1,$2,$3,$4,'update',$5,$6,$7,$8)`,
            [current.id,auth.principalId,auth.credentialId,key ?? `server:${randomUUID()}`,
              updated.rows[0].sequence,hash,delivery,snapshot],
          );
          await recordActivityCorrelationDecision(client,{
            principalId: auth.principalId,
            activityId: current.id,
            outcome: "reused",
            matchedBy: "activity_key",
            actor: "cli",
            reason: "active_activity_key_match",
          });
          await transaction.commit();
          return context.json({ activity: snapshot,delivery,queued: delivery.apnsJobs,
            disposition: "reused",replayed: false,reused: true,resumed: false });
        }
      }
      const blockingRows = originHash
        ? blockers.rows.filter((row: any) => Boolean(input.key)
          && row.requester_credential_id === auth.credentialId
          && row.requester_service_id === null
          && row.activity_key === input.key)
        : input.key
          ? blockers.rows.filter((row: any) => row.requester_credential_id === auth.credentialId
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
        return context.json({
          error: "active_activity_conflict",
          code: "ACTIVE_ACTIVITY_CONFLICT",
          disposition: "blocked",
          ...(sameManualOwner
            ? { activityId: publicId("act",first.id) } : {}),
        },409);
      }
      const replaced = input.replace && blockingRows.length
        ? await replaceBlockingTaskActivities(client,{
          principalId: auth.principalId,
          sourceName: auth.clientName ?? "Relo CLI",
          blockerIds: blockingRows.map((row: any) => row.id),
          apnsMode,
        })
        : 0;
      const storedKey = key ?? `server:${randomUUID()}`;
      const privacy = "standard";
      const expiresAt = new Date(Date.now()+input.expiresInSeconds*1000);
      const staleAt = new Date(Math.min(
        Date.now()+input.staleAfterSeconds*1000,
        expiresAt.getTime(),
      ));
      const generation = originSlot?.nextGeneration ?? 1;
      const result = await client.query<any>(
        `INSERT INTO live_activities(
           principal_id,requester_credential_id,activity_key,title,status,detail,progress,symbol,style,privacy,accent_color,
           target_device_ids,start_idempotency_key,start_request_hash,context,expires_at,stale_at,
           start_replace_requested,start_replaced_count,presentation,presentation_sha256,origin_hash,generation,
           lifecycle_provider,lifecycle_run_id,presentation_policy,presentation_policy_source,
           presentation_preset_id,presentation_preset_revision
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING *`,
        [auth.principalId,auth.credentialId,input.key ?? null,input.title,input.status,input.detail ?? null,
          input.progress ?? null,input.symbol,input.style,privacy,input.accentColor,
          devices.map((device) => device.id),storedKey,hash,input.context ?? null,expiresAt,staleAt,
          input.replace,replaced,input.presentation,storedPresentation.presentationHash,originHash,generation,
          input.lifecycle?.provider ?? null,input.lifecycle?.runId ?? null,
          presentationPolicy,presentationPolicy.source,
          presentationPolicy.presetId,presentationPolicy.presetRevision],
      );
      const delivery = await createActivityCommands(client,{
        principalId: auth.principalId,
        sourceName: auth.clientName ?? "Relo CLI",
        activity: result.rows[0],
        operation: "start",
        apnsMode,
        requestedDeviceIds: devices.map((device) => device.id),
      });
      const snapshot = serializeTaskActivity(result.rows[0]);
      await client.query(
        "UPDATE live_activities SET start_delivery_summary=$2::jsonb,start_snapshot=$3::jsonb WHERE id=$1",
        [result.rows[0].id,delivery,snapshot],
      );
      await recordActivityStartEvidence(client,{
        principalId: auth.principalId,
        activityId: result.rows[0].id,
        actor: "cli",
        previousActivityId: originSlot?.latest?.id ?? null,
        supersededActivityIds: blockingRows.map((row: any) => row.id),
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
      return context.json({ activity: snapshot, delivery, queued: delivery.apnsJobs, replayed: false,
        disposition: replaced > 0 ? "replaced" : "created",
        ...originGenerationMetadata(result.rows[0],false),
        ...(input.replace ? { replaced } : {}) },201);
    } catch (error) {
      await transaction.rollback();
      if (error instanceof PresentationRuntimeError) return context.json({ error: error.code },409);
      if (key) {
        const replay = await db.query<any>(
          `SELECT * FROM live_activities WHERE principal_id=$1 AND requester_service_id IS NULL
             AND (requester_credential_id=$2 OR requester_credential_id IS NULL)
             AND start_idempotency_key=$3 ORDER BY (requester_credential_id=$2) DESC LIMIT 1`,
          [auth.principalId,auth.credentialId,key],
        );
        if (replay.rowCount) {
          const row = replay.rows[0]!;
          if (row.requester_credential_id !== auth.credentialId) {
            return context.json({ error: "idempotency_conflict" },409);
          }
          if (!row.start_request_hash || row.start_request_hash !== hash || !row.start_snapshot) {
            return context.json({ error: "idempotency_conflict" },409);
          }
          const delivery = activityDeliverySummarySchema.parse(row.start_delivery_summary);
          return context.json({ activity: row.start_snapshot, delivery, queued: delivery.apnsJobs,
            disposition: "replayed",replayed: true,...originGenerationMetadata(row,false),
            ...(row.start_replace_requested ? { replaced: row.start_replaced_count } : {}) });
        }
      }
      if (originHash) {
        const replay = await activityReplay(db,auth.principalId,auth.credentialId,key,"update",hash);
        if (replay?.conflict) return context.json({ error: "idempotency_conflict" },409);
        if (replay?.snapshot && replay.delivery) {
          return context.json({ activity: replay.snapshot,delivery: replay.delivery,
            queued: replay.delivery.apnsJobs,disposition: "replayed",
            replayed: true,reused: true,resumed: false });
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
      if (keyed.rowCount) return context.json({ error: "activity_key_conflict" },409);
      throw error;
    } finally { await transaction.close(); }
  });

  app.post("/api/live-activities/:activityId/heartbeat", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:write")) return context.json({ error: "forbidden" },403);
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const identifier = context.req.param("activityId") ?? "";
    const input = activityHeartbeatSchema.parse(await context.req.json());
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const selection = await resolveMutationActivity(
        client,auth.principalId,auth.credentialId,identifier,true,
      );
      if (selection.ambiguous) {
        await transaction.rollback();
        return context.json({ error: "activity_selection_ambiguous",code: "ACTIVITY_SELECTION_AMBIGUOUS" },409);
      }
      const current = selection.activity;
      if (!current) {
        await transaction.rollback();
        return context.json({ error: "not_found" },404);
      }
      if (!lifecycleMutationAllowed(current,input.lifecycle)) {
        await transaction.rollback();
        return context.json({ error: "activity_owner_conflict",code: "ACTIVITY_OWNER_CONFLICT",
          disposition: "blocked" },409);
      }
      const leaseExpired = current.lifecycle_provider !== null
        && new Date(current.stale_at) <= new Date();
      if (current.state === "active" && (new Date(current.expires_at) <= new Date() || leaseExpired)) {
        await expireLockedRows(client,[current],apnsMode);
        await transaction.commit();
        const terminal = await resolveOwnedActivity(
          db,auth.principalId,publicId("act",current.id),false,auth.credentialId,
        );
        return context.json({ error: "activity_terminal",activity: serializeTaskActivity(terminal) },409);
      }
      if (current.state !== "active") {
        await transaction.rollback();
        return context.json({ error: "activity_terminal",activity: serializeTaskActivity(current) },409);
      }
      const renewed = (await client.query<any>(
        `UPDATE live_activities
         SET stale_at=LEAST(now()+($3*interval '1 second'),expires_at),updated_at=now()
         WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
        [current.id,auth.principalId,input.leaseAfterSeconds],
      )).rows[0];
      await transaction.commit();
      return context.json({ activity: serializeTaskActivity(renewed),renewed: true });
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      await transaction.close();
    }
  });

  app.patch("/api/live-activities/:activityId", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:write")) return context.json({ error: "forbidden" },403);
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const identifier = context.req.param("activityId") ?? "";
    const rawInput = activityUpdateSchema.parse(await context.req.json());
    const key = idempotencyKey(context.req.header("idempotency-key"));
    let hashInput: unknown = rawInput;
    try {
      if (rawInput.presentation) {
        hashInput = { ...rawInput,presentation: canonicalPresentation(rawInput.presentation) };
      }
    } catch (error) {
      if (error instanceof PresentationRuntimeError) return context.json({ error: error.code },400);
      throw error;
    }
    const hash = taskActivityRequestHash("update",{ identifier, ...hashInput as object });
    const selection = await resolveMutationActivity(
      db,auth.principalId,auth.credentialId,identifier,
    );
    if (selection.ambiguous) {
      return context.json({ error: "activity_selection_ambiguous",code: "ACTIVITY_SELECTION_AMBIGUOUS" },409);
    }
    const resolved = selection.activity;
    if (!resolved) return context.json({ error: "not_found" },404);
    if (!lifecycleMutationAllowed(resolved,rawInput.lifecycle)) {
      return context.json({ error: "activity_owner_conflict",code: "ACTIVITY_OWNER_CONFLICT",
        disposition: "blocked" },409);
    }
    const existing = await activityReplay(db,auth.principalId,auth.credentialId,key,"update",hash);
    if (existing?.conflict) return context.json({ error: "idempotency_conflict" },409);
    if (existing?.snapshot && existing.delivery) {
      return context.json({ activity: existing.snapshot, delivery: existing.delivery, queued: existing.delivery.apnsJobs, replayed: true });
    }
    const effectivePolicy = await loadClientPresentationPolicy(
      db,auth.principalId,auth.credentialId,
    );
    let input: typeof rawInput;
    try {
      input = applyActivityPrivacyPolicy(rawInput,effectivePolicy.policy);
    } catch (error) {
      if (error instanceof ActivityPrivacyPolicyError) return context.json({ error: error.code },409);
      throw error;
    }
    const activityId = resolved.id;

    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const currentSelection = await resolveMutationActivity(
        client,auth.principalId,auth.credentialId,publicId("act",activityId),true,
      );
      const currentRow = currentSelection.activity;
      if (!currentRow) { await transaction.rollback(); return context.json({ error: "not_found" },404); }
      if (!lifecycleMutationAllowed(currentRow,input.lifecycle)) {
        await transaction.rollback();
        return context.json({ error: "activity_owner_conflict",code: "ACTIVITY_OWNER_CONFLICT",
          disposition: "blocked" },409);
      }
      const concurrentReplay = await activityReplay(client,auth.principalId,auth.credentialId,key,"update",hash);
      if (concurrentReplay?.conflict) {
        await transaction.rollback();
        return context.json({ error: "idempotency_conflict" },409);
      }
      if (concurrentReplay?.snapshot && concurrentReplay.delivery) {
        await transaction.commit();
        return context.json({ activity: concurrentReplay.snapshot, delivery: concurrentReplay.delivery,
          queued: concurrentReplay.delivery.apnsJobs, replayed: true });
      }
      if (currentRow.state === "active" && new Date(currentRow.expires_at) <= new Date()) {
        await expireLockedRows(client,[currentRow],apnsMode);
        await transaction.commit();
        const terminal = await resolveOwnedActivity(db,auth.principalId,publicId("act",activityId),false,auth.credentialId);
        return context.json({ error: "activity_terminal", activity: serializeTaskActivity(terminal) },409);
      }
      if (currentRow.state !== "active") {
        await transaction.rollback();
        return context.json({ error: "activity_terminal", activity: serializeTaskActivity(currentRow) },409);
      }
      if (input.ifSequence !== undefined && Number(currentRow.sequence) !== input.ifSequence) {
        await transaction.rollback();
        return context.json({ error: "sequence_conflict", activity: serializeTaskActivity(currentRow) },409);
      }
      const progress = currentRow.lifecycle_provider && typeof input.progress === "number"
        && typeof currentRow.progress === "number"
        ? Math.max(input.progress,currentRow.progress)
        : input.progress;
      const semanticInput = input.presentation ? input : {
        ...input,
        title: input.title ?? boundedPresentationText(input.context?.taskTitle,80) ?? currentRow.title,
        status: input.status ?? currentRow.status,
        detail: input.detail !== undefined
          ? input.detail
          : input.context?.threadName ?? currentRow.detail,
        progress: progress !== undefined ? progress : currentRow.progress,
      };
      const resolvedPresentation = resolveActivityPresentation(semanticInput,{
        principalId: auth.principalId,effective: effectivePolicy,
      });
      const stored = preserveActivePresentationPolicy(
        currentRow,semanticInput,resolvedPresentation.stored,
      );
      await assertAccountPresentationAssets(client,auth.principalId,stored.presentation);
      const previousStaleSeconds = currentRow.stale_at
        ? Math.max(0,Math.round((new Date(currentRow.stale_at).getTime()-new Date(currentRow.updated_at).getTime())/1000))
        : DEFAULT_STALE_AFTER_SECONDS;
      const staleAfterSeconds = input.staleAfterSeconds ?? previousStaleSeconds;
      const updated = await client.query<any>(
        `UPDATE live_activities SET
           title=$3,status=$4,detail=$5,progress=$6,symbol=$7,privacy=$8,
           accent_color=$9,style=$10,presentation=$11,presentation_sha256=$12,
           context=CASE WHEN $13::jsonb IS NULL THEN context
             ELSE COALESCE(context,'{}'::jsonb)||$13::jsonb END,
           stale_at=LEAST(now()+($14*interval '1 second'),expires_at),
           sequence=sequence+1,updated_at=now()
         WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
        [activityId,auth.principalId,stored.title,stored.status,stored.detail,stored.progress,
          stored.symbol,stored.privacy,stored.accentColor,stored.style,stored.presentation,
          stored.presentationHash,input.context ?? null,staleAfterSeconds],
      );
      await cancelPendingActivityInteractions(client,auth.principalId,activityId);
      const delivery = await createActivityCommands(client,{
        principalId: auth.principalId,
        sourceName: auth.clientName ?? "Relo CLI",
        activity: updated.rows[0],
        operation: "update",
        apnsMode,
        priority: 10,
      });
      const snapshot = serializeTaskActivity(updated.rows[0]);
      await client.query(
        `INSERT INTO live_activity_operations(
           live_activity_id,principal_id,requester_credential_id,idempotency_key,operation,resulting_sequence,request_hash,
           delivery_summary,activity_snapshot
         ) VALUES ($1,$2,$3,$4,'update',$5,$6,$7,$8)`,
        [activityId,auth.principalId,auth.credentialId,key ?? `server:${randomUUID()}`,updated.rows[0].sequence,
          hash,delivery,snapshot],
      );
      await transaction.commit();
      return context.json({ activity: snapshot, delivery, queued: delivery.apnsJobs, replayed: false });
    } catch (error) {
      await transaction.rollback();
      if (error instanceof PresentationRuntimeError) return context.json({ error: error.code },409);
      const replay = await activityReplay(db,auth.principalId,auth.credentialId,key,"update",hash);
      if (replay?.conflict) return context.json({ error: "idempotency_conflict" },409);
      if (replay?.snapshot && replay.delivery) {
        return context.json({ activity: replay.snapshot, delivery: replay.delivery, queued: replay.delivery.apnsJobs, replayed: true });
      }
      throw error;
    } finally { await transaction.close(); }
  });

  app.post("/api/live-activities/:activityId/wait", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:write") || !auth.scopes.has("interactions:create")) {
      return context.json({ error: "forbidden" },403);
    }
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const externalActivityId = context.req.param("activityId") ?? "";
    const activityId = internalId("act",externalActivityId);
    if (!activityId) return context.json({ error: "not_found" },404);
    const key = requiredIdempotencyKey(context.req.header("idempotency-key"));
    if (!key) return context.json({ error: "idempotency_key_required" },400);
    const input = activityWaitSchema.parse(await context.req.json());
    const hash = taskActivityRequestHash("wait",{ activityId: externalActivityId,...input });
    const existing = await activityWaitReplay(db,auth.principalId,auth.credentialId,activityId,key);
    if (existing) {
      if (existing.request_hash !== hash) return context.json({ error: "idempotency_conflict" },409);
      return context.json(activityWaitResponse(existing,externalActivityId,apnsMode,true));
    }

    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",[
        `activity-wait:${auth.credentialId}:${activityId}`,
      ]);
      const concurrent = await activityWaitReplay(client,auth.principalId,auth.credentialId,activityId,key);
      if (concurrent) {
        if (concurrent.request_hash === hash) await transaction.commit();
        else await transaction.rollback();
        return concurrent.request_hash === hash
          ? context.json(activityWaitResponse(concurrent,externalActivityId,apnsMode,true))
          : context.json({ error: "idempotency_conflict" },409);
      }
      const reusedKey = await client.query(
        `SELECT 1 FROM live_activity_operations
         WHERE requester_credential_id=$1 AND idempotency_key=$2
         UNION ALL
         SELECT 1 FROM notification_events
         WHERE requester_credential_id=$1 AND idempotency_key=$2 LIMIT 1`,
        [auth.credentialId,key],
      );
      if (reusedKey.rowCount) {
        await transaction.rollback();
        return context.json({ error: "idempotency_conflict" },409);
      }
      const parent = await client.query<any>(
        `SELECT * FROM live_activities
         WHERE id=$1 AND principal_id=$2 AND requester_credential_id=$3
           AND requester_service_id IS NULL FOR UPDATE`,
        [activityId,auth.principalId,auth.credentialId],
      );
      if (!parent.rowCount) {
        await transaction.rollback();
        return context.json({ error: "not_found" },404);
      }
      const parentRow = parent.rows[0]!;
      if (parentRow.state !== "active" || new Date(parentRow.expires_at).getTime() <= Date.now()) {
        await transaction.rollback();
        return context.json({ error: "activity_not_active" },409);
      }
      const targetIds = parentRow.target_device_ids as string[];
      if (!targetIds.length) {
        await transaction.rollback();
        return context.json({ error: "activity_target_unavailable" },409);
      }
      const devices = await client.query<any>(
        `SELECT d.id,d.apns_environment,d.apns_token,d.live_activity_push_to_start_token
         FROM unnest($1::uuid[]) WITH ORDINALITY target(id,position)
         JOIN devices d ON d.id=target.id
         WHERE d.principal_id=$2 AND d.revoked_at IS NULL
           AND (CASE WHEN $3::boolean THEN
             d.notification_authorization IN ('authorized','provisional')
           ELSE d.live_activity_authorization='authorized' END)
         ORDER BY target.position`,
        [targetIds,auth.principalId,input.type === "text"],
      );
      if (devices.rows.length !== targetIds.length) {
        await transaction.rollback();
        return context.json({ error: "activity_target_unavailable" },409);
      }
      const source = await client.query<{ source: string }>(
        `SELECT source FROM notification_events
         WHERE principal_id=$1 AND requester_credential_id=$2
           AND payload#>>'{liveActivity,activityId}'=$3 ORDER BY created_at,id LIMIT 1`,
        [auth.principalId,auth.credentialId,externalActivityId],
      );
      const sourceName = source.rows[0]?.source ?? auth.clientName ?? "Relo CLI";
      const expiresAt = new Date(Math.min(
        new Date(parentRow.expires_at).getTime(),Date.now()+input.expiresInSeconds*1_000,
      ));
      const event = await client.query<{ id: string }>(
        `INSERT INTO notification_events(
           principal_id,requester_credential_id,source,kind,title,body,payload,idempotency_key,
           expires_at,request_hash,target_mode,origin_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8,$9,'explicit',$10) RETURNING id`,
        [auth.principalId,auth.credentialId,sourceName,input.type === "text" ? "question" : "live_activity",
          parentRow.title,input.prompt,key,expiresAt,hash,parentRow.origin_hash ?? null],
      );
      await client.query(
        `INSERT INTO notification_event_targets(notification_event_id,device_id)
         SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
        [event.rows[0]!.id,targetIds],
      );
      const request = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO interaction_requests(
           principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,expires_at`,
        [auth.principalId,event.rows[0]!.id,input.type,input.prompt,hashToken(generateToken()),expiresAt],
      );
      const interactionId = publicId("int",request.rows[0]!.id);
      let companionActivityId: string | null = null;
      let apnsJobs = 0;
      if (input.type === "text") {
        await client.query(
          "UPDATE notification_events SET payload=$2::jsonb WHERE id=$1",
          [event.rows[0]!.id,{ interactionId,interactionType: "text",
            liveActivityWait: { parentActivityId: externalActivityId,companionActivityId: null } }],
        );
        if (apnsMode !== "disabled") {
          const jobs = await client.query(
            `INSERT INTO delivery_jobs(notification_event_id,device_id)
             SELECT $1,d.id FROM devices d WHERE d.id=ANY($2::uuid[]) AND d.principal_id=$3
               AND d.revoked_at IS NULL AND d.apns_environment=$4::apns_environment
               AND d.apns_token IS NOT NULL
               AND d.notification_authorization IN ('authorized','provisional')
             ON CONFLICT DO NOTHING`,
            [event.rows[0]!.id,targetIds,auth.principalId,apnsMode],
          );
          apnsJobs = jobs.rowCount ?? 0;
        }
      } else {
        const style = input.type === "approval" ? "approval" : "verdict";
        const primaryLabel = input.primaryLabel ?? (input.type === "approval" ? "Approve" : "Yes");
        const secondaryLabel = input.secondaryLabel ?? (input.type === "approval" ? "Deny" : "No");
        const companionPresentation = canonicalPresentation({
          content: { header: sourceName,title: parentRow.title,subtitle: input.prompt,status: "Waiting for input" },
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
        const companionStored = persistedPresentationColumns(companionPresentation);
        const companion = await client.query<{ id: string; generation: number }>(
          `INSERT INTO live_activities(
             principal_id,requester_credential_id,title,status,detail,style,privacy,accent_color,
             target_device_ids,start_idempotency_key,expires_at,stale_at,presentation,presentation_sha256,
             presentation_policy,presentation_policy_source,presentation_preset_id,presentation_preset_revision
           ) VALUES ($1,$2,$3,'Waiting for input',$4,$5,'standard','#5ED8B7',$6,$7,$8,$8,$9,$10,
             $11::jsonb,'system',$12,1)
           RETURNING id,generation`,
          [auth.principalId,auth.credentialId,parentRow.title,input.prompt,style,targetIds,
            `wait:${key}`,expiresAt,companionStored.presentation,companionStored.presentationHash,
            systemPresentationPolicySnapshot(`system.interactive.${style}`),`system.interactive.${style}`],
        );
        const insertedCompanionActivityId: string = companion.rows[0]!.id;
        companionActivityId = insertedCompanionActivityId;
        const command = {
          operation: "start",activityId: publicId("act",insertedCompanionActivityId),
          generation: Number(companion.rows[0]!.generation),
          targetDeviceId: publicId("dev",devices.rows[0]!.id),style,sourceName,
          ...presentationCommandProjection(companionPresentation),privacy: "standard",
          expiresAt: expiresAt.toISOString(),staleAt: expiresAt.toISOString(),
          alertOwner: "app",sequence: 0,priority: 10,dismissAfterSeconds: null,interaction: null,
        };
        await client.query(
          "UPDATE notification_events SET payload=$2::jsonb WHERE id=$1",
          [event.rows[0]!.id,{ liveActivity: command,interactionId,interactionType: input.type,
            liveActivityWait: { parentActivityId: externalActivityId,
              companionActivityId: publicId("act",insertedCompanionActivityId) } }],
        );
        if (apnsMode !== "disabled") {
          const jobs = await client.query(
            `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
             SELECT $1,d.id,'live_activity_start',$3 FROM devices d
             WHERE d.id=ANY($2::uuid[]) AND d.principal_id=$4 AND d.revoked_at IS NULL
               AND d.apns_environment=$5::apns_environment
               AND d.live_activity_push_to_start_token IS NOT NULL
             ON CONFLICT DO NOTHING`,
            [event.rows[0]!.id,targetIds,insertedCompanionActivityId,auth.principalId,apnsMode],
          );
          apnsJobs = jobs.rowCount ?? 0;
        }
      }
      const delivery = { eligibleDevices: targetIds.length,durableCommands: 1,apnsJobs };
      await client.query(
        "UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",
        [event.rows[0]!.id,delivery],
      );
      await client.query(
        `INSERT INTO live_activity_operations(
           live_activity_id,principal_id,requester_credential_id,idempotency_key,operation,
           resulting_sequence,request_hash,delivery_summary,activity_snapshot,companion_activity_id
         ) VALUES ($1,$2,$3,$4,'wait',$5,$6,$7,$8,$9)`,
        [activityId,auth.principalId,auth.credentialId,key,parentRow.sequence,hash,delivery,
          serializeTaskActivity(parentRow),companionActivityId],
      );
      if (companionActivityId) {
        await recordActivityStartEvidence(client,{
          principalId: auth.principalId,
          activityId: companionActivityId,
          actor: "cli",
          parentActivityId: activityId,
          matchedBy: "parent",
          reason: "interactive_companion",
        });
      }
      const created = await activityWaitReplay(client,auth.principalId,auth.credentialId,activityId,key);
      if (!created) throw new Error("activity wait persistence failed");
      await transaction.commit();
      return context.json(activityWaitResponse(created,externalActivityId,apnsMode,false),201);
    } catch (error) {
      await transaction.rollback();
      const replay = await activityWaitReplay(db,auth.principalId,auth.credentialId,activityId,key);
      if (replay?.request_hash === hash) {
        return context.json(activityWaitResponse(replay,externalActivityId,apnsMode,true));
      }
      throw error;
    } finally { await transaction.close(); }
  });

  app.post("/api/live-activities/:activityId/end", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:write")) return context.json({ error: "forbidden" },403);
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const identifier = context.req.param("activityId") ?? "";
    const input = activityEndSchema.parse(await context.req.json().catch(() => ({})));
    const key = idempotencyKey(context.req.header("idempotency-key"));
    let hashInput: unknown = input;
    try {
      if (input.presentation) hashInput = { ...input,presentation: canonicalPresentation(input.presentation) };
    } catch (error) {
      if (error instanceof PresentationRuntimeError) return context.json({ error: error.code },400);
      throw error;
    }
    const hash = taskActivityRequestHash("end",{ identifier, ...hashInput as object });
    const selection = await resolveMutationActivity(
      db,auth.principalId,auth.credentialId,identifier,
    );
    if (selection.ambiguous) {
      return context.json({ error: "activity_selection_ambiguous",code: "ACTIVITY_SELECTION_AMBIGUOUS" },409);
    }
    const resolved = selection.activity;
    if (!resolved) return context.json({ error: "not_found" },404);
    if (!lifecycleMutationAllowed(resolved,input.lifecycle)) {
      return context.json({ error: "activity_owner_conflict",code: "ACTIVITY_OWNER_CONFLICT",
        disposition: "blocked" },409);
    }
    const existing = await activityReplay(db,auth.principalId,auth.credentialId,key,"end",hash);
    if (existing?.conflict) return context.json({ error: "idempotency_conflict" },409);
    if (existing?.snapshot && existing.delivery) {
      return context.json({ activity: existing.snapshot, delivery: existing.delivery,
        queued: existing.delivery.apnsJobs, dismissAfterSeconds: existing.dismissAfterSeconds ?? null, replayed: true });
    }
    const activityId = resolved.id;

    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const currentSelection = await resolveMutationActivity(
        client,auth.principalId,auth.credentialId,publicId("act",activityId),true,
      );
      const currentRow = currentSelection.activity;
      if (!currentRow) { await transaction.rollback(); return context.json({ error: "not_found" },404); }
      if (!lifecycleMutationAllowed(currentRow,input.lifecycle)) {
        await transaction.rollback();
        return context.json({ error: "activity_owner_conflict",code: "ACTIVITY_OWNER_CONFLICT",
          disposition: "blocked" },409);
      }
      const concurrentReplay = await activityReplay(client,auth.principalId,auth.credentialId,key,"end",hash);
      if (concurrentReplay?.conflict) {
        await transaction.rollback();
        return context.json({ error: "idempotency_conflict" },409);
      }
      if (concurrentReplay?.snapshot && concurrentReplay.delivery) {
        await transaction.commit();
        return context.json({ activity: concurrentReplay.snapshot, delivery: concurrentReplay.delivery,
          queued: concurrentReplay.delivery.apnsJobs,
          dismissAfterSeconds: concurrentReplay.dismissAfterSeconds ?? null, replayed: true });
      }
      if (currentRow.state === "active" && new Date(currentRow.expires_at) <= new Date()) {
        await expireLockedRows(client,[currentRow],apnsMode);
        await transaction.commit();
        const terminal = await resolveOwnedActivity(db,auth.principalId,publicId("act",activityId),false,auth.credentialId);
        return context.json({ error: "activity_terminal", activity: serializeTaskActivity(terminal) },409);
      }
      if (currentRow.state !== "active") {
        await transaction.rollback();
        return context.json({ error: "activity_terminal", activity: serializeTaskActivity(currentRow) },409);
      }
      if (input.ifSequence !== undefined && Number(currentRow.sequence) !== input.ifSequence) {
        await transaction.rollback();
        return context.json({ error: "sequence_conflict", activity: serializeTaskActivity(currentRow) },409);
      }
      const stored = input.presentation
        ? persistedPresentationColumns(canonicalPresentation(input.presentation))
        : terminalPresentationColumnsFromRow(
            currentRow,input.status ?? "Complete",input.symbol === "warning" ? "warning" : "success",
            { detail: input.detail,progress: input.progress,accentColor: input.accentColor },
          );
      await assertAccountPresentationAssets(client,auth.principalId,stored.presentation);
      const ended = await client.query<any>(
        `UPDATE live_activities SET state='ended',
           title=$3,status=$4,detail=$5,progress=$6,symbol=$7,
           privacy=$8,accent_color=$9,style=$10,presentation=$11,presentation_sha256=$12,
           terminal_reason='explicit_end',terminal_actor=$13,
           terminal_policy='producer_terminal',terminal_transition_at=now(),
           sequence=sequence+1,ended_at=now(),updated_at=now()
         WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
        [activityId,auth.principalId,stored.title,stored.status,stored.detail,stored.progress,
          stored.symbol,stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash,
          input.lifecycle ? `provider:${input.lifecycle.provider}` : "credential"],
      );
      await cancelPendingActivityInteractions(client,auth.principalId,activityId);
      const dismissAfterSeconds = input.dismissAfterSeconds;
      const delivery = await createActivityCommands(client,{
        principalId: auth.principalId,
        sourceName: auth.clientName ?? "Relo CLI",
        activity: ended.rows[0],
        operation: "end",
        apnsMode,
        dismissAfterSeconds,
      });
      await cleanupUndeliverableTerminalTokens(client,activityId);
      const snapshot = serializeTaskActivity(ended.rows[0]);
      await client.query(
        `INSERT INTO live_activity_operations(
           live_activity_id,principal_id,requester_credential_id,idempotency_key,operation,resulting_sequence,request_hash,delivery_summary,
           dismiss_after_seconds,activity_snapshot
         ) VALUES ($1,$2,$3,$4,'end',$5,$6,$7,$8,$9)`,
        [activityId,auth.principalId,auth.credentialId,key ?? `server:${randomUUID()}`,ended.rows[0].sequence,
          hash,delivery,dismissAfterSeconds,snapshot],
      );
      await transaction.commit();
      return context.json({ activity: snapshot, delivery, queued: delivery.apnsJobs,
        dismissAfterSeconds, replayed: false });
    } catch (error) {
      await transaction.rollback();
      if (error instanceof PresentationRuntimeError) return context.json({ error: error.code },409);
      const replay = await activityReplay(db,auth.principalId,auth.credentialId,key,"end",hash);
      if (replay?.conflict) return context.json({ error: "idempotency_conflict" },409);
      if (replay?.snapshot && replay.delivery) {
        return context.json({ activity: replay.snapshot, delivery: replay.delivery,
          queued: replay.delivery.apnsJobs, dismissAfterSeconds: replay.dismissAfterSeconds ?? null, replayed: true });
      }
      throw error;
    } finally { await transaction.close(); }
  });

  app.post("/api/live-activities/resolve", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:read")) return context.json({ error: "forbidden" },403);
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const input = activityResolveSchema.parse(await context.req.json());
    await expireDueActivities(db,apnsMode);
    const result = await resolveActivitySelector(db,{
      principalId: auth.principalId,credentialId: auth.credentialId,serviceId: null,
    },input);
    if (result.ambiguous) {
      return context.json({ error: "activity_selection_ambiguous",code: "ACTIVITY_SELECTION_AMBIGUOUS" },409);
    }
    return result.activity
      ? context.json({ found: true,activity: serializeTaskActivity(result.activity) })
      : context.json({ found: false,activity: null });
  });

  app.get("/api/live-activities", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:read")) return context.json({ error: "forbidden" },403);
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    await expireDueActivities(db,apnsMode);
    const result = await db.query<any>(
      `SELECT * FROM live_activities WHERE principal_id=$1 AND requester_credential_id=$2
       AND requester_service_id IS NULL
       AND presentation IS NOT NULL ORDER BY updated_at DESC LIMIT 100`,
      [auth.principalId,auth.credentialId],
    );
    return context.json({ activities: result.rows.map(serializeTaskActivity) });
  });

  app.get("/api/live-activities/:activityId", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:read")) return context.json({ error: "forbidden" },403);
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    await expireDueActivities(db,apnsMode);
    const row = await resolveOwnedActivity(db,auth.principalId,context.req.param("activityId") ?? "",false,auth.credentialId);
    return row ? context.json({ activity: serializeTaskActivity(row) }) : context.json({ error: "not_found" },404);
  });
}
