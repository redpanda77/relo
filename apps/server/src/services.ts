import { createHash, randomBytes, randomUUID } from "node:crypto";
import { httpsUrlSchema, publicHttpsUrlSchema } from "./url-policy.js";
import type { Hono } from "hono";
import { z } from "zod";
import {
  activityDeliverySummarySchema,
  activityEndSchema,
  activityResolveSchema,
  activityStartSchema,
  activityUpdateSchema,
  cancelPendingActivityInteractions,
  createActivityCommands,
  expireDueActivities,
  serializeTaskActivity,
  taskActivityRequestHash,
  type ApnsMode,
} from "./activities.js";
import { generateToken, hashToken, requireScope } from "./auth.js";
import type { Database } from "./db.js";
import { internalId, publicId } from "./ids.js";
import {
  beginActivityTransaction,
  resolveActivityByIdentifier,
  resolveActivityReplay,
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
import { consumeRateLimit } from "./rate-limit.js";
import { assertOrdinaryDeliveryIntentWithinBudget } from "./delivery-serialization.js";
import {
  PresentationRuntimeError,
  assertAccountPresentationAssets,
  canonicalPresentation,
  patchPresentationColumns,
  persistedPresentationColumns,
  terminalPresentationColumnsFromRow,
} from "./presentation-runtime.js";
import {
  ActivityPrivacyPolicyError,
  applyActivityPrivacyPolicy,
  loadServicePresentationPolicy,
  preserveActivePresentationPolicy,
  resolveActivityPresentation,
} from "./presentation-policy.js";
import {
  MAX_NOTIFICATION_BODY_BYTES,
  createNotificationContentCipher,
  persistNotificationContent,
  prepareNotificationContent,
  type NotificationContentCipher,
} from "./notification-content.js";

const serviceCreateSchema = z.object({
  title: z.string().trim().min(1).max(80),
  imageUrl: publicHttpsUrlSchema.nullable().optional(),
  destinationUrl: httpsUrlSchema.nullable().optional(),
}).strict();
const serviceUpdateSchema = serviceCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required.",
);

const webhookSchema = z.object({
  body: z.string().trim().min(1).refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_NOTIFICATION_BODY_BYTES,
    "Notification body must be at most 65,536 UTF-8 bytes.",
  ),
  summary: z.string().trim().min(1).refine(
    (value) => Array.from(value).length <= 240,
    "Notification summary must be at most 240 characters.",
  ).optional(),
  bodyFormat: z.enum(["text", "markdown"]).optional(),
  title: z.string().trim().min(1).max(80).optional(),
  imageUrl: publicHttpsUrlSchema.optional(),
  url: httpsUrlSchema.optional(),
  deepLink: httpsUrlSchema.optional(),
  deviceIds: z.array(z.string()).min(1).max(50)
    .transform((values) => [...new Set(values)].sort()).optional(),
  response: z.object({
    type: z.enum(["approval","yes_no","text"]),
    expiresInSeconds: z.number().int().min(30).max(86_400).default(900),
    correlationId: z.string().trim().min(1).max(100).optional(),
  }).strict().optional(),
  origin: originDescriptorSchema.optional(),
}).strict().superRefine((value,context) => {
  if (value.url !== undefined && value.deepLink !== undefined) {
    context.addIssue({ code: "custom", message: "Use url or deepLink, not both." });
  }
  if (value.response && Buffer.byteLength(value.body, "utf8") > 2_000) {
    context.addIssue({ code: "custom", message: "Interactive prompts must be at most 2,000 UTF-8 bytes." });
  }
});

function webhookRequestHash(value: z.infer<typeof webhookSchema>): string {
  return createHash("sha256").update(`relo:webhook-request:v1\n${JSON.stringify(value)}`).digest("hex");
}

function selectedDeviceIds(values: string[] | undefined): string[] | null {
  if (values === undefined) return null;
  const internal = values.map((value) => internalId("dev",value));
  if (internal.some((value) => !value || !z.uuid().safeParse(value).success)) return [];
  return internal as string[];
}

function webhookHash(secret: string): string {
  return hashToken(`relo:webhook:v1\n${secret}`);
}

function newWebhookSecret(): string {
  return `hook_${randomBytes(32).toString("base64url")}`;
}

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };

function serviceActivityIdempotencyKey(value: string | undefined): string | undefined {
  return value === undefined ? undefined : z.string().trim().min(1).max(200).parse(value);
}

async function serviceForSecret(query: Queryable, secret: string, forUpdate = false): Promise<any | undefined> {
  if (!/^hook_[A-Za-z0-9_-]{43}$/.test(secret)) return undefined;
  const result = await query.query(
    `SELECT * FROM webhook_services WHERE secret_hash=$1 AND revoked_at IS NULL${forUpdate ? " FOR SHARE" : ""}`,
    [webhookHash(secret)],
  );
  return result.rows[0];
}

async function serviceMutationRateLimit(context: any, db: Database, service: any): Promise<Response | null> {
  const [serviceLimit,accountLimit] = await Promise.all([
    consumeRateLimit(db,{ scope: "service", id: service.id, family: "authenticated-mutations", limit: 60 }),
    consumeRateLimit(db,{ scope: "account", id: service.principal_id, family: "authenticated-mutations", limit: 300 }),
  ]);
  if (serviceLimit.allowed && accountLimit.allowed) return null;
  const retryAfterSeconds = Math.max(
    serviceLimit.allowed ? 0 : serviceLimit.retryAfterSeconds,
    accountLimit.allowed ? 0 : accountLimit.retryAfterSeconds,
  );
  context.header("retry-after",String(retryAfterSeconds));
  return context.json({ ok: false, error: "rate_limited" },429);
}

async function resolveServiceActivity(
  query: Queryable,
  principalId: string,
  serviceId: string,
  identifier: string,
  forUpdate = false,
): Promise<any | undefined> {
  if (!z.string().trim().min(1).max(100).safeParse(identifier).success) return undefined;
  return resolveActivityByIdentifier(query,{
    principalId,credentialId: null,serviceId,
  },identifier,forUpdate);
}

const serviceActivityReplay = (
  query: Queryable,
  principalId: string,
  serviceId: string,
  key: string | undefined,
  operation: "update" | "end",
  hash: string,
) => resolveActivityReplay(query,{
  principalId,credentialId: null,serviceId,
},key,operation,hash,(delivery) => activityDeliverySummarySchema.parse(delivery));

async function associateServiceActivityEvents(
  query: Queryable,
  principalId: string,
  serviceId: string,
  activityId: string,
): Promise<void> {
  await query.query(
    `UPDATE notification_events SET service_id=$3
     WHERE principal_id=$1 AND payload#>>'{liveActivity,activityId}'=$2 AND service_id IS NULL`,
    [principalId,publicId("act",activityId),serviceId],
  );
}

async function cleanupServiceTerminalTokens(query: Queryable, activityId: string): Promise<void> {
  await query.query(
    `DELETE FROM live_activity_update_tokens t
     WHERE t.live_activity_id=$1 AND NOT EXISTS (
       SELECT 1 FROM delivery_jobs j
       JOIN notification_events e ON e.id=j.notification_event_id
       WHERE j.live_activity_id=t.live_activity_id AND j.device_id=t.device_id
         AND j.transport='live_activity_update'
         AND e.payload#>>'{liveActivity,operation}'='end'
     )`,
    [activityId],
  );
}

async function replaceBlockingActivity(
  query: Queryable,
  input: { service: any; activity: any; apnsMode: ApnsMode },
): Promise<void> {
  const stored = terminalPresentationColumnsFromRow(input.activity,"Replaced","warning");
  const ended = (await query.query(
    `UPDATE live_activities SET state='replaced',title=$3,status=$4,detail=$5,progress=$6,
       symbol=$7,privacy=$8,accent_color=$9,style=$10,presentation=$11,presentation_sha256=$12,
       terminal_reason='explicit_replace',terminal_actor='service',
       terminal_policy='replacement',terminal_transition_at=now(),
       sequence=sequence+1,ended_at=now(),updated_at=now()
     WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
    [input.activity.id,input.service.principal_id,stored.title,stored.status,stored.detail,stored.progress,
      stored.symbol,stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash],
  )).rows[0];
  if (!ended) return;
  await cancelPendingActivityInteractions(query,input.service.principal_id,ended.id);
  const delivery = await createActivityCommands(query,{
    principalId: input.service.principal_id,
    sourceName: input.service.title,
    activity: ended,
    operation: "end",
    apnsMode: input.apnsMode,
    dismissAfterSeconds: 0,
  });
  if (ended.requester_service_id) {
    await associateServiceActivityEvents(query,input.service.principal_id,ended.requester_service_id,ended.id);
  }
  await cleanupServiceTerminalTokens(query,ended.id);
  const snapshot = serializeTaskActivity(ended);
  await query.query(
    `INSERT INTO live_activity_operations(
       live_activity_id,principal_id,requester_service_id,requester_credential_id,idempotency_key,
       operation,resulting_sequence,request_hash,delivery_summary,dismiss_after_seconds,activity_snapshot
     ) VALUES ($1,$2,$3,$4,$5,'end',$6,$7,$8,0,$9)`,
    [ended.id,input.service.principal_id,ended.requester_service_id ?? null,ended.requester_credential_id ?? null,
      `service:replaced:${randomUUID()}`,ended.sequence,
      taskActivityRequestHash("replaced",{ activityId: publicId("act",ended.id), sequence: Number(ended.sequence) }),
      delivery,snapshot],
  );
}

export async function createWebhookService(
  db: Database,
  principalId: string,
  title: string,
  appUrl: string,
  defaults?: { imageUrl?: string | null; destinationUrl?: string | null },
) {
  const secret = newWebhookSecret();
  const result = await db.query<any>(
    `INSERT INTO webhook_services(principal_id,title,image_url,default_url,secret_hash,secret_prefix)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [principalId,title,defaults?.imageUrl ?? null,defaults?.destinationUrl ?? null,
      webhookHash(secret),secret.slice(0,13)],
  );
  return { row: result.rows[0], webhookUrl: `${appUrl.replace(/\/$/, "")}/hooks/${secret}` };
}

export async function rotateWebhookService(db: Database, principalId: string, serviceId: string, appUrl: string) {
  const secret = newWebhookSecret();
  const result = await db.query<any>(
    `UPDATE webhook_services SET secret_hash=$3,secret_prefix=$4,updated_at=now(),revoked_at=NULL
     WHERE id=$1 AND principal_id=$2 RETURNING *`,
    [serviceId,principalId,webhookHash(secret),secret.slice(0,13)],
  );
  if (!result.rowCount) return null;
  return { row: result.rows[0], webhookUrl: `${appUrl.replace(/\/$/, "")}/hooks/${secret}` };
}

function serviceResource(row: any) {
  return {
    id: publicId("svc",row.id),
    title: row.title,
    imageUrl: row.image_url,
    destinationUrl: row.default_url,
    prefix: row.secret_prefix,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function registerServiceApiRoutes(app: Hono, db: Database, appUrl?: string): void {
  app.get("/api/services", requireScope("services:read"), async (context) => {
    const auth = context.get("auth");
    const result = await db.query<any>(
      `SELECT id,title,image_url,default_url,secret_prefix,created_at,updated_at
       FROM webhook_services WHERE principal_id=$1 AND revoked_at IS NULL
       ORDER BY created_at DESC,id DESC`,
      [auth.principalId],
    );
    return context.json({ services: result.rows.map(serviceResource) });
  });

  app.post("/api/services", requireScope("services:write"), async (context) => {
    const auth = context.get("auth");
    const input = serviceCreateSchema.parse(await context.req.json());
    const publicOrigin = appUrl ?? new URL(context.req.url).origin;
    const defaults = {
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
      ...(input.destinationUrl !== undefined ? { destinationUrl: input.destinationUrl } : {}),
    };
    const created = await createWebhookService(db,auth.principalId,input.title,publicOrigin,defaults);
    return context.json({ service: serviceResource(created.row), webhookUrl: created.webhookUrl },201);
  });

  app.patch("/api/services/:serviceId", requireScope("services:write"), async (context) => {
    const auth = context.get("auth");
    const serviceId = internalId("svc",context.req.param("serviceId") ?? "");
    if (!serviceId) return context.json({ error: "not_found" },404);
    const input = serviceUpdateSchema.parse(await context.req.json());
    const result = await db.query<any>(
      `UPDATE webhook_services SET
         title=CASE WHEN $3::boolean THEN $4 ELSE title END,
         image_url=CASE WHEN $5::boolean THEN $6 ELSE image_url END,
         default_url=CASE WHEN $7::boolean THEN $8 ELSE default_url END,
         updated_at=now()
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING *`,
      [serviceId,auth.principalId,
        input.title !== undefined,input.title ?? null,
        input.imageUrl !== undefined,input.imageUrl ?? null,
        input.destinationUrl !== undefined,input.destinationUrl ?? null],
    );
    return result.rowCount
      ? context.json({ service: serviceResource(result.rows[0]) })
      : context.json({ error: "not_found" },404);
  });

  app.post("/api/services/:serviceId/rotate", requireScope("services:write"), async (context) => {
    const auth = context.get("auth");
    const serviceId = internalId("svc",context.req.param("serviceId") ?? "");
    if (!serviceId) return context.json({ error: "not_found" },404);
    const publicOrigin = appUrl ?? new URL(context.req.url).origin;
    const rotated = await rotateWebhookService(db,auth.principalId,serviceId,publicOrigin);
    return rotated
      ? context.json({ service: serviceResource(rotated.row), webhookUrl: rotated.webhookUrl })
      : context.json({ error: "not_found" },404);
  });

  app.delete("/api/services/:serviceId", requireScope("services:write"), async (context) => {
    const auth = context.get("auth");
    const serviceId = internalId("svc",context.req.param("serviceId") ?? "");
    if (!serviceId) return context.json({ error: "not_found" },404);
    const result = await db.query(
      `UPDATE webhook_services SET revoked_at=COALESCE(revoked_at,now()),updated_at=now()
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id`,
      [serviceId,auth.principalId],
    );
    return result.rowCount ? context.json({ ok: true }) : context.json({ error: "not_found" },404);
  });
}

function registerServiceActivityRoutes(app: Hono, db: Database, apnsMode: ApnsMode): void {
  app.post("/hooks/:secret/live-activities", async (context) => {
    const secret = context.req.param("secret");
    const service = await serviceForSecret(db,secret);
    if (!service) return context.json({ ok: false, error: "unknown_webhook" },404);
    const limited = await serviceMutationRateLimit(context,db,service);
    if (limited) return limited;
    const rawInput = activityStartSchema.parse(await context.req.json());
    const effectivePolicy = await loadServicePresentationPolicy(db,service);
    let storedPresentation: ReturnType<typeof persistedPresentationColumns>;
    let presentationPolicy: ReturnType<typeof resolveActivityPresentation>["snapshot"];
    try {
      const resolved = resolveActivityPresentation(rawInput,{
        principalId: service.principal_id,effective: effectivePolicy,
      });
      storedPresentation = resolved.stored;
      presentationPolicy = resolved.snapshot;
    } catch (error) {
      if (error instanceof ActivityPrivacyPolicyError) {
        return context.json({ ok: false,error: error.code },409);
      }
      if (error instanceof PresentationRuntimeError) return context.json({ ok: false,error: error.code },400);
      throw error;
    }
    const input = { ...rawInput,
      title: storedPresentation.title,status: storedPresentation.status,detail: storedPresentation.detail,
      progress: storedPresentation.progress,symbol: storedPresentation.symbol,style: storedPresentation.style,
      privacy: storedPresentation.privacy,privacyMode: storedPresentation.privacy,
      accentColor: storedPresentation.accentColor,presentation: storedPresentation.presentation };
    const requestedIds = selectedDeviceIds(input.deviceIds);
    if (input.deviceIds && !requestedIds?.length) return context.json({ ok: false, error: "invalid_device_selection" },400);
    const key = serviceActivityIdempotencyKey(context.req.header("idempotency-key"));
    const hash = taskActivityRequestHash("service-start",{
      ...rawInput,
      deviceIds: rawInput.deviceIds ? [...rawInput.deviceIds].sort() : undefined,
    });
    const originHash = input.origin ? canonicalOriginHash(service.principal_id,input.origin) : null;
    const existing = key ? await db.query<any>(
      "SELECT * FROM live_activities WHERE requester_service_id=$1 AND start_idempotency_key=$2",
      [service.id,key],
    ) : undefined;
    if (existing?.rowCount) {
      const row = existing.rows[0]!;
      if (row.start_request_hash !== hash || !row.start_snapshot) {
        return context.json({ ok: false, error: "idempotency_conflict" },409);
      }
      const delivery = activityDeliverySummarySchema.parse(row.start_delivery_summary);
      return context.json({ ok: true, activity: row.start_snapshot, delivery, queued: delivery.apnsJobs,
        replayed: true,...originGenerationMetadata(row,false),
        ...(row.start_replace_requested ? { replaced: row.start_replaced_count } : {}) });
    }
    if (input.lifecycle) {
      const lifecycleExisting = await db.query<any>(
        `SELECT * FROM live_activities
         WHERE requester_service_id=$1 AND requester_credential_id IS NULL
           AND lifecycle_provider=$2 AND lifecycle_run_id=$3 LIMIT 1`,
        [service.id,input.lifecycle.provider,input.lifecycle.runId],
      );
      if (lifecycleExisting.rowCount) {
        const row = lifecycleExisting.rows[0]!;
        if (row.start_request_hash !== hash || !row.start_snapshot) {
          return context.json({ ok: false,error: "lifecycle_run_conflict",code: "LIFECYCLE_RUN_CONFLICT" },409);
        }
        const delivery = activityDeliverySummarySchema.parse(row.start_delivery_summary);
        return context.json({ ok: true,activity: row.start_snapshot,delivery,queued: delivery.apnsJobs,
          replayed: true,...originGenerationMetadata(row,false) });
      }
    }
    const originReplay = originHash
      ? await serviceActivityReplay(db,service.principal_id,service.id,key,"update",hash)
      : null;
    if (originReplay?.conflict) return context.json({ ok: false,error: "idempotency_conflict" },409);
    if (originReplay?.snapshot && originReplay.delivery) {
      return context.json({ ok: true,activity: originReplay.snapshot,delivery: originReplay.delivery,
        queued: originReplay.delivery.apnsJobs,replayed: true,reused: true,resumed: false });
    }

    await expireDueActivities(db,apnsMode);
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const lockedService = await serviceForSecret(client,secret,true);
      if (!lockedService) {
        await transaction.rollback();
        return context.json({ ok: false, error: "unknown_webhook" },404);
      }
      await assertAccountPresentationAssets(client,lockedService.principal_id,input.presentation);
      const originSlot = originHash
        ? await lockOriginGenerationSlot(client,lockedService.principal_id,originHash)
        : null;
      if (!originHash) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",[lockedService.principal_id]);
      }
      if (key) {
        const concurrent = await client.query<any>(
          "SELECT * FROM live_activities WHERE requester_service_id=$1 AND start_idempotency_key=$2",
          [lockedService.id,key],
        );
        if (concurrent.rowCount) {
          const row = concurrent.rows[0]!;
          if (row.start_request_hash !== hash || !row.start_snapshot) {
            await transaction.rollback();
            return context.json({ ok: false, error: "idempotency_conflict" },409);
          }
          await transaction.commit();
          const delivery = activityDeliverySummarySchema.parse(row.start_delivery_summary);
          return context.json({ ok: true, activity: row.start_snapshot, delivery, queued: delivery.apnsJobs,
            replayed: true,...originGenerationMetadata(row,false),
            ...(row.start_replace_requested ? { replaced: row.start_replaced_count } : {}) });
        }
      }
      if (input.lifecycle) {
        const concurrentLifecycle = await client.query<any>(
          `SELECT * FROM live_activities
           WHERE requester_service_id=$1 AND requester_credential_id IS NULL
             AND lifecycle_provider=$2 AND lifecycle_run_id=$3 LIMIT 1`,
          [lockedService.id,input.lifecycle.provider,input.lifecycle.runId],
        );
        if (concurrentLifecycle.rowCount) {
          const row = concurrentLifecycle.rows[0]!;
          if (row.start_request_hash !== hash || !row.start_snapshot) {
            await transaction.rollback();
            return context.json({ ok: false,error: "lifecycle_run_conflict",code: "LIFECYCLE_RUN_CONFLICT" },409);
          }
          await transaction.commit();
          const delivery = activityDeliverySummarySchema.parse(row.start_delivery_summary);
          return context.json({ ok: true,activity: row.start_snapshot,delivery,queued: delivery.apnsJobs,
            replayed: true,...originGenerationMetadata(row,false) });
        }
      }
      const devices = await client.query<any>(
        `SELECT id FROM devices WHERE principal_id=$1 AND revoked_at IS NULL
           AND live_activity_authorization='authorized'
           AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[])) ORDER BY id`,
        [lockedService.principal_id,requestedIds],
      );
      if (requestedIds && devices.rows.length !== requestedIds.length) {
        await transaction.rollback();
        return context.json({ ok: false, error: "invalid_device_selection" },400);
      }
      const targetIds = devices.rows.map((device: { id: string }) => device.id);
      const blockers = originSlot ? {
        rows: originSlot.active ? [originSlot.active] : [],
        rowCount: originSlot.active ? 1 : 0,
      } : await client.query<any>(
        `SELECT * FROM live_activities WHERE principal_id=$1 AND state='active'
           AND presentation IS NOT NULL
           AND (($3::text IS NOT NULL AND requester_service_id=$2 AND activity_key=$3)
             OR (cardinality($4::uuid[])>0 AND target_device_ids && $4::uuid[]))
         ORDER BY created_at FOR UPDATE`,
        [lockedService.principal_id,lockedService.id,input.key ?? null,targetIds],
      );
      const latestOrigin = originSlot?.latest;
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
        return context.json({ ok: false,error: "active_origin_conflict",code: "ACTIVE_ORIGIN_CONFLICT" },409);
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
          return context.json({ ok: false,error: "active_origin_run_conflict",code: "ACTIVE_ORIGIN_RUN_CONFLICT",
            activityId: publicId("act",current.id) },409);
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
          return context.json({ ok: false,error: "origin_target_conflict",code: "ORIGIN_TARGET_CONFLICT",
            activityId: publicId("act",current.id) },409);
        }
        const replay = await serviceActivityReplay(
          client,lockedService.principal_id,lockedService.id,key,"update",hash,
        );
        if (replay?.conflict) {
          await transaction.rollback();
          return context.json({ ok: false,error: "idempotency_conflict" },409);
        }
        if (replay?.snapshot && replay.delivery) {
          await transaction.commit();
          return context.json({ ok: true,activity: replay.snapshot,delivery: replay.delivery,
            queued: replay.delivery.apnsJobs,replayed: true,reused: true,resumed: false });
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
           WHERE id=$1 AND requester_service_id=$2 AND state='active' RETURNING *`,
          [current.id,lockedService.id,activePresentation.title,activePresentation.status,
            activePresentation.detail,activePresentation.progress,activePresentation.symbol,
            activePresentation.style,activePresentation.privacy,activePresentation.accentColor,
            activePresentation.presentation,activePresentation.presentationHash,
            input.context ?? null,input.staleAfterSeconds,
            input.lifecycle?.provider ?? null,input.lifecycle?.runId ?? null,
            current.presentation_policy_source,
            current.presentation_preset_id,current.presentation_preset_revision],
        );
        await cancelPendingActivityInteractions(client,lockedService.principal_id,current.id);
        const delivery = await createActivityCommands(client,{
          principalId: lockedService.principal_id,sourceName: lockedService.title,
          activity: updated.rows[0],operation: "update",apnsMode,
        });
        await associateServiceActivityEvents(client,lockedService.principal_id,lockedService.id,current.id);
        const snapshot = serializeTaskActivity(updated.rows[0]);
        await client.query(
          `INSERT INTO live_activity_operations(
             live_activity_id,principal_id,requester_service_id,idempotency_key,operation,
             resulting_sequence,request_hash,delivery_summary,activity_snapshot
           ) VALUES ($1,$2,$3,$4,'update',$5,$6,$7,$8)`,
          [current.id,lockedService.principal_id,lockedService.id,key ?? `server:${randomUUID()}`,
            updated.rows[0].sequence,hash,delivery,snapshot],
        );
        await recordActivityCorrelationDecision(client,{
          principalId: lockedService.principal_id,
          activityId: current.id,
          outcome: "reused",
          matchedBy: input.lifecycle ? "lifecycle" : "origin",
          actor: "service",
          reason: input.lifecycle ? "active_lifecycle_match" : "active_origin_match",
        });
        await transaction.commit();
        return context.json({ ok: true,activity: snapshot,delivery,queued: delivery.apnsJobs,
          replayed: false,reused: true,resumed: false });
      }
      if (blockers.rowCount && !input.replace) {
        await transaction.rollback();
        const owned = blockers.rows.find((row: any) => row.requester_service_id === lockedService.id);
        await recordActivityCorrelationDecision(db,{
          principalId: lockedService.principal_id,
          activityId: owned?.id ?? null,
          outcome: "blocked_conflict",
          matchedBy: input.key ? "activity_key" : "current",
          actor: "service",
          reason: "active_activity_requires_replacement",
        });
        return context.json({ ok: false, error: "active_activity_conflict", code: "ACTIVE_ACTIVITY_CONFLICT",
          ...(owned ? { activityId: publicId("act",owned.id) } : {}) },409);
      }
      for (const blocker of input.replace ? blockers.rows : []) {
        await replaceBlockingActivity(client,{ service: lockedService, activity: blocker, apnsMode });
      }
      const expiresAt = new Date(Date.now()+input.expiresInSeconds*1000);
      const staleAt = new Date(Math.min(Date.now()+input.staleAfterSeconds*1000,expiresAt.getTime()));
      const generation = originSlot?.nextGeneration ?? 1;
      const result = await client.query<any>(
        `INSERT INTO live_activities(
           principal_id,requester_service_id,activity_key,title,status,detail,progress,symbol,style,privacy,accent_color,
           target_device_ids,start_idempotency_key,start_request_hash,context,expires_at,stale_at,
           start_replace_requested,start_replaced_count,presentation,presentation_sha256,origin_hash,generation,
           lifecycle_provider,lifecycle_run_id,presentation_policy,presentation_policy_source,
           presentation_preset_id,presentation_preset_revision
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING *`,
        [lockedService.principal_id,lockedService.id,input.key ?? null,input.title,input.status,
          input.detail ?? null,input.progress ?? null,input.symbol,input.style,"standard",input.accentColor,
          targetIds,key ?? `server:${randomUUID()}`,hash,input.context ?? null,expiresAt,staleAt,input.replace,
          blockers.rows.length,input.presentation,storedPresentation.presentationHash,originHash,generation,
          input.lifecycle?.provider ?? null,input.lifecycle?.runId ?? null,
          presentationPolicy,presentationPolicy.source,
          presentationPolicy.presetId,presentationPolicy.presetRevision],
      );
      const delivery = await createActivityCommands(client,{
        principalId: lockedService.principal_id,
        sourceName: lockedService.title,
        activity: result.rows[0],
        operation: "start",
        apnsMode,
        requestedDeviceIds: targetIds,
      });
      await associateServiceActivityEvents(client,lockedService.principal_id,lockedService.id,result.rows[0].id);
      const snapshot = serializeTaskActivity(result.rows[0]);
      await client.query(
        "UPDATE live_activities SET start_delivery_summary=$2::jsonb,start_snapshot=$3::jsonb WHERE id=$1",
        [result.rows[0].id,delivery,snapshot],
      );
      await recordActivityStartEvidence(client,{
        principalId: lockedService.principal_id,
        activityId: result.rows[0].id,
        actor: "service",
        previousActivityId: originSlot?.latest?.id ?? null,
        supersededActivityIds: input.replace ? blockers.rows.map((row: any) => row.id) : [],
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
      return context.json({ ok: true, activity: snapshot, delivery, queued: delivery.apnsJobs,
        ...originGenerationMetadata(result.rows[0],false),
        replayed: false, ...(input.replace ? { replaced: blockers.rows.length } : {}) },201);
    } catch (error) {
      await transaction.rollback();
      if (error instanceof PresentationRuntimeError) return context.json({ ok: false,error: error.code },409);
      if (key) {
        const replay = await db.query<any>(
          "SELECT * FROM live_activities WHERE requester_service_id=$1 AND start_idempotency_key=$2",
          [service.id,key],
        );
        if (replay.rowCount) {
          const row = replay.rows[0]!;
          if (row.start_request_hash !== hash || !row.start_snapshot) {
            return context.json({ ok: false, error: "idempotency_conflict" },409);
          }
          const delivery = activityDeliverySummarySchema.parse(row.start_delivery_summary);
          return context.json({ ok: true, activity: row.start_snapshot, delivery, queued: delivery.apnsJobs,
            replayed: true,...originGenerationMetadata(row,false),
            ...(row.start_replace_requested ? { replaced: row.start_replaced_count } : {}) });
        }
      }
      if (originHash) {
        const replay = await serviceActivityReplay(
          db,service.principal_id,service.id,key,"update",hash,
        );
        if (replay?.conflict) return context.json({ ok: false,error: "idempotency_conflict" },409);
        if (replay?.snapshot && replay.delivery) {
          return context.json({ ok: true,activity: replay.snapshot,delivery: replay.delivery,
            queued: replay.delivery.apnsJobs,replayed: true,reused: true,resumed: false });
        }
      }
      if (input.lifecycle) {
        const replay = await db.query<any>(
          `SELECT * FROM live_activities
           WHERE requester_service_id=$1 AND requester_credential_id IS NULL
             AND lifecycle_provider=$2 AND lifecycle_run_id=$3 LIMIT 1`,
          [service.id,input.lifecycle.provider,input.lifecycle.runId],
        );
        if (replay.rowCount) {
          const row = replay.rows[0]!;
          if (row.start_request_hash !== hash || !row.start_snapshot) {
            return context.json({ ok: false,error: "lifecycle_run_conflict",code: "LIFECYCLE_RUN_CONFLICT" },409);
          }
          const delivery = activityDeliverySummarySchema.parse(row.start_delivery_summary);
          return context.json({ ok: true,activity: row.start_snapshot,delivery,queued: delivery.apnsJobs,
            replayed: true,...originGenerationMetadata(row,false) });
        }
      }
      throw error;
    } finally { await transaction.close(); }
  });

  app.post("/hooks/:secret/live-activities/resolve", async (context) => {
    const service = await serviceForSecret(db,context.req.param("secret"));
    if (!service) return context.json({ ok: false,error: "activity_not_found" },404);
    const input = activityResolveSchema.parse(await context.req.json());
    await expireDueActivities(db,apnsMode);
    const selection = await resolveActivitySelector(db,{
      principalId: service.principal_id,credentialId: null,serviceId: service.id,
    },input);
    if (selection.ambiguous) {
      await recordActivityCorrelationDecision(db,{
        principalId: service.principal_id,
        outcome: "blocked_ambiguous",
        matchedBy: "current",
        actor: "service",
        reason: "multiple_current_candidates",
      });
      return context.json({ ok: false,error: "activity_selection_ambiguous",
        code: "ACTIVITY_SELECTION_AMBIGUOUS" },409);
    }
    return selection.activity
      ? context.json({ ok: true,found: true,activity: serializeTaskActivity(selection.activity) })
      : context.json({ ok: true,found: false,activity: null });
  });

  app.get("/hooks/:secret/live-activities/:identifier", async (context) => {
    const service = await serviceForSecret(db,context.req.param("secret"));
    if (!service) return context.json({ ok: false, error: "activity_not_found" },404);
    await expireDueActivities(db,apnsMode);
    const activity = await resolveServiceActivity(
      db,service.principal_id,service.id,context.req.param("identifier") ?? "",
    );
    return activity
      ? context.json({ ok: true, activity: serializeTaskActivity(activity) })
      : context.json({ ok: false, error: "activity_not_found" },404);
  });

  app.patch("/hooks/:secret/live-activities/:identifier", async (context) => {
    const secret = context.req.param("secret");
    const service = await serviceForSecret(db,secret);
    if (!service) return context.json({ ok: false, error: "activity_not_found" },404);
    const limited = await serviceMutationRateLimit(context,db,service);
    if (limited) return limited;
    const identifier = context.req.param("identifier") ?? "";
    const rawInput = activityUpdateSchema.parse(await context.req.json());
    const key = serviceActivityIdempotencyKey(context.req.header("idempotency-key"));
    let hashInput: unknown = rawInput;
    try {
      if (rawInput.presentation) {
        hashInput = { ...rawInput,presentation: canonicalPresentation(rawInput.presentation) };
      }
    } catch (error) {
      if (error instanceof PresentationRuntimeError) return context.json({ ok: false,error: error.code },400);
      throw error;
    }
    const hash = taskActivityRequestHash("service-update",{ identifier,...hashInput as object });
    const replay = await serviceActivityReplay(
      db,service.principal_id,service.id,key,"update",hash,
    );
    if (replay?.conflict) return context.json({ ok: false, error: "idempotency_conflict" },409);
    if (replay?.snapshot && replay.delivery) return context.json({ ok: true, activity: replay.snapshot,
      delivery: replay.delivery, queued: replay.delivery.apnsJobs, replayed: true });
    const effectivePolicy = await loadServicePresentationPolicy(db,service);
    let input: typeof rawInput;
    try {
      input = applyActivityPrivacyPolicy(rawInput,effectivePolicy.policy);
    } catch (error) {
      if (error instanceof ActivityPrivacyPolicyError) {
        return context.json({ ok: false,error: error.code },409);
      }
      throw error;
    }
    await expireDueActivities(db,apnsMode);
    const resolved = await resolveServiceActivity(db,service.principal_id,service.id,identifier);
    if (!resolved) return context.json({ ok: false, error: "activity_not_found" },404);
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const lockedService = await serviceForSecret(client,secret,true);
      const current = lockedService ? await resolveServiceActivity(
        client,lockedService.principal_id,lockedService.id,publicId("act",resolved.id),true,
      ) : undefined;
      if (!lockedService || !current) {
        await transaction.rollback();
        return context.json({ ok: false, error: "activity_not_found" },404);
      }
      const concurrent = await serviceActivityReplay(
        client,lockedService.principal_id,lockedService.id,key,"update",hash,
      );
      if (concurrent?.conflict) {
        await transaction.rollback();
        return context.json({ ok: false, error: "idempotency_conflict" },409);
      }
      if (concurrent?.snapshot && concurrent.delivery) {
        await transaction.commit();
        return context.json({ ok: true, activity: concurrent.snapshot, delivery: concurrent.delivery,
          queued: concurrent.delivery.apnsJobs, replayed: true });
      }
      if (current.state !== "active") {
        await transaction.rollback();
        return context.json({ ok: false, error: "activity_terminal", activity: serializeTaskActivity(current) },409);
      }
      if (input.ifSequence !== undefined && Number(current.sequence) !== input.ifSequence) {
        await transaction.rollback();
        return context.json({ ok: false, error: "sequence_conflict", activity: serializeTaskActivity(current) },409);
      }
      const semanticInput = {
        ...input,
        title: input.title ?? input.context?.taskTitle,
        detail: input.detail ?? input.context?.threadName,
      };
      const stored = input.presentation
        ? persistedPresentationColumns(canonicalPresentation(input.presentation))
        : patchPresentationColumns(current,semanticInput);
      await assertAccountPresentationAssets(client,lockedService.principal_id,stored.presentation);
      const previousStaleSeconds = current.stale_at
        ? Math.max(0,Math.round((new Date(current.stale_at).getTime()-new Date(current.updated_at).getTime())/1000))
        : 14_400;
      const updated = await client.query<any>(
        `UPDATE live_activities SET
           title=$3,status=$4,detail=$5,progress=$6,symbol=$7,privacy=$8,
           accent_color=$9,style=$10,presentation=$11,presentation_sha256=$12,
           context=CASE WHEN $13::jsonb IS NULL THEN context
             ELSE COALESCE(context,'{}'::jsonb)||$13::jsonb END,
           stale_at=LEAST(now()+($14*interval '1 second'),expires_at),
           sequence=sequence+1,updated_at=now()
         WHERE id=$1 AND requester_service_id=$2 AND state='active' RETURNING *`,
        [current.id,lockedService.id,stored.title,stored.status,stored.detail,stored.progress,
          stored.symbol,stored.privacy,stored.accentColor,stored.style,stored.presentation,
          stored.presentationHash,input.context ?? null,input.staleAfterSeconds ?? previousStaleSeconds],
      );
      await cancelPendingActivityInteractions(client,lockedService.principal_id,current.id);
      const delivery = await createActivityCommands(client,{ principalId: lockedService.principal_id,
        sourceName: lockedService.title, activity: updated.rows[0], operation: "update", apnsMode,
        ...(input.deliveryPriority === undefined ? {} : { priority: input.deliveryPriority }) });
      await associateServiceActivityEvents(client,lockedService.principal_id,lockedService.id,current.id);
      const snapshot = serializeTaskActivity(updated.rows[0]);
      await client.query(
        `INSERT INTO live_activity_operations(
           live_activity_id,principal_id,requester_service_id,idempotency_key,operation,resulting_sequence,
           request_hash,delivery_summary,activity_snapshot
         ) VALUES ($1,$2,$3,$4,'update',$5,$6,$7,$8)`,
        [current.id,lockedService.principal_id,lockedService.id,key ?? `server:${randomUUID()}`,
          updated.rows[0].sequence,hash,delivery,snapshot],
      );
      await transaction.commit();
      return context.json({ ok: true, activity: snapshot, delivery, queued: delivery.apnsJobs, replayed: false });
    } catch (error) {
      await transaction.rollback();
      if (error instanceof PresentationRuntimeError) return context.json({ ok: false,error: error.code },409);
      const concurrent = await serviceActivityReplay(
        db,service.principal_id,service.id,key,"update",hash,
      );
      if (concurrent?.conflict) return context.json({ ok: false, error: "idempotency_conflict" },409);
      if (concurrent?.snapshot && concurrent.delivery) return context.json({ ok: true, activity: concurrent.snapshot,
        delivery: concurrent.delivery, queued: concurrent.delivery.apnsJobs, replayed: true });
      throw error;
    } finally { await transaction.close(); }
  });

  app.post("/hooks/:secret/live-activities/:identifier/end", async (context) => {
    const secret = context.req.param("secret");
    const service = await serviceForSecret(db,secret);
    if (!service) return context.json({ ok: false, error: "activity_not_found" },404);
    const limited = await serviceMutationRateLimit(context,db,service);
    if (limited) return limited;
    const identifier = context.req.param("identifier") ?? "";
    const input = activityEndSchema.parse(await context.req.json().catch(() => ({})));
    const key = serviceActivityIdempotencyKey(context.req.header("idempotency-key"));
    let hashInput: unknown = input;
    try {
      if (input.presentation) hashInput = { ...input,presentation: canonicalPresentation(input.presentation) };
    } catch (error) {
      if (error instanceof PresentationRuntimeError) return context.json({ ok: false,error: error.code },400);
      throw error;
    }
    const hash = taskActivityRequestHash("service-end",{ identifier,...hashInput as object });
    const replay = await serviceActivityReplay(
      db,service.principal_id,service.id,key,"end",hash,
    );
    if (replay?.conflict) return context.json({ ok: false, error: "idempotency_conflict" },409);
    if (replay?.snapshot && replay.delivery) return context.json({ ok: true, activity: replay.snapshot,
      delivery: replay.delivery, queued: replay.delivery.apnsJobs,
      dismissAfterSeconds: replay.dismissAfterSeconds ?? null, replayed: true });
    await expireDueActivities(db,apnsMode);
    const resolved = await resolveServiceActivity(db,service.principal_id,service.id,identifier);
    if (!resolved) return context.json({ ok: false, error: "activity_not_found" },404);
    const transaction = await beginActivityTransaction(db);
    const client = transaction.client;
    try {
      const lockedService = await serviceForSecret(client,secret,true);
      const current = lockedService ? await resolveServiceActivity(
        client,lockedService.principal_id,lockedService.id,publicId("act",resolved.id),true,
      ) : undefined;
      if (!lockedService || !current) {
        await transaction.rollback();
        return context.json({ ok: false, error: "activity_not_found" },404);
      }
      const concurrent = await serviceActivityReplay(
        client,lockedService.principal_id,lockedService.id,key,"end",hash,
      );
      if (concurrent?.conflict) {
        await transaction.rollback();
        return context.json({ ok: false, error: "idempotency_conflict" },409);
      }
      if (concurrent?.snapshot && concurrent.delivery) {
        await transaction.commit();
        return context.json({ ok: true, activity: concurrent.snapshot, delivery: concurrent.delivery,
          queued: concurrent.delivery.apnsJobs, dismissAfterSeconds: concurrent.dismissAfterSeconds ?? null, replayed: true });
      }
      if (current.state !== "active") {
        await transaction.rollback();
        return context.json({ ok: false, error: "activity_terminal", activity: serializeTaskActivity(current) },409);
      }
      if (input.ifSequence !== undefined && Number(current.sequence) !== input.ifSequence) {
        await transaction.rollback();
        return context.json({ ok: false, error: "sequence_conflict", activity: serializeTaskActivity(current) },409);
      }
      const stored = input.presentation
        ? persistedPresentationColumns(canonicalPresentation(input.presentation))
        : terminalPresentationColumnsFromRow(
            current,input.status ?? "Complete",input.symbol === "warning" ? "warning" : "success",
            { detail: input.detail,progress: input.progress,accentColor: input.accentColor },
          );
      await assertAccountPresentationAssets(client,lockedService.principal_id,stored.presentation);
      const ended = await client.query<any>(
        `UPDATE live_activities SET state='ended',title=$3,status=$4,detail=$5,progress=$6,
           symbol=$7,privacy=$8,accent_color=$9,style=$10,presentation=$11,presentation_sha256=$12,
           terminal_reason='explicit_end',terminal_actor='service',
           terminal_policy='producer_terminal',terminal_transition_at=now(),
           sequence=sequence+1,ended_at=now(),updated_at=now()
         WHERE id=$1 AND requester_service_id=$2 AND state='active' RETURNING *`,
        [current.id,lockedService.id,stored.title,stored.status,stored.detail,stored.progress,
          stored.symbol,stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash],
      );
      await cancelPendingActivityInteractions(client,lockedService.principal_id,current.id);
      const delivery = await createActivityCommands(client,{ principalId: lockedService.principal_id,
        sourceName: lockedService.title, activity: ended.rows[0], operation: "end", apnsMode,
        dismissAfterSeconds: input.dismissAfterSeconds });
      await associateServiceActivityEvents(client,lockedService.principal_id,lockedService.id,current.id);
      await cleanupServiceTerminalTokens(client,current.id);
      const snapshot = serializeTaskActivity(ended.rows[0]);
      await client.query(
        `INSERT INTO live_activity_operations(
           live_activity_id,principal_id,requester_service_id,idempotency_key,operation,resulting_sequence,
           request_hash,delivery_summary,dismiss_after_seconds,activity_snapshot
         ) VALUES ($1,$2,$3,$4,'end',$5,$6,$7,$8,$9)`,
        [current.id,lockedService.principal_id,lockedService.id,key ?? `server:${randomUUID()}`,
          ended.rows[0].sequence,hash,delivery,input.dismissAfterSeconds,snapshot],
      );
      await transaction.commit();
      return context.json({ ok: true, activity: snapshot, delivery, queued: delivery.apnsJobs,
        dismissAfterSeconds: input.dismissAfterSeconds, replayed: false });
    } catch (error) {
      await transaction.rollback();
      if (error instanceof PresentationRuntimeError) return context.json({ ok: false,error: error.code },409);
      const concurrent = await serviceActivityReplay(
        db,service.principal_id,service.id,key,"end",hash,
      );
      if (concurrent?.conflict) return context.json({ ok: false, error: "idempotency_conflict" },409);
      if (concurrent?.snapshot && concurrent.delivery) return context.json({ ok: true, activity: concurrent.snapshot,
        delivery: concurrent.delivery, queued: concurrent.delivery.apnsJobs,
        dismissAfterSeconds: concurrent.dismissAfterSeconds ?? null, replayed: true });
      throw error;
    } finally { await transaction.close(); }
  });
}

export function registerWebhookRoutes(
  app: Hono,
  db: Database,
  apnsMode: ApnsMode = "disabled",
  contentCipher: NotificationContentCipher = createNotificationContentCipher(
    "relo-test-notification-content-secret-v1",
  ),
): void {
  registerServiceActivityRoutes(app,db,apnsMode);
  app.post("/hooks/:secret", async (context) => {
    const secret = context.req.param("secret");
    if (!/^hook_[A-Za-z0-9_-]{43}$/.test(secret)) return context.json({ ok: false, error: "unknown_webhook" }, 404);
    const service = await db.query<any>(
      `SELECT * FROM webhook_services WHERE secret_hash=$1 AND revoked_at IS NULL`,
      [webhookHash(secret)],
    );
    if (!service.rowCount) return context.json({ ok: false, error: "unknown_webhook" }, 404);
    const limited = await serviceMutationRateLimit(context,db,service.rows[0]);
    if (limited) return limited;
    const input = webhookSchema.parse(await context.req.json());
    const content = prepareNotificationContent(input);
    const row = service.rows[0];
    const originHash = !input.response && input.origin
      ? canonicalOriginHash(row.principal_id,input.origin)
      : null;
    const requestedDeviceIds = selectedDeviceIds(input.deviceIds);
    if (input.deviceIds !== undefined && !requestedDeviceIds?.length) {
      return context.json({ ok: false, error: "invalid_device_selection" },400);
    }
    const idempotencyKey = z.string().trim().min(1).max(200).parse(
      context.req.header("idempotency-key") ?? `webhook-${randomBytes(16).toString("hex")}`,
    );
    const requestHash = webhookRequestHash(input);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const eligible = await client.query<{ id: string; apns_token: string | null }>(
        `SELECT id,apns_token FROM devices
         WHERE principal_id=$1 AND revoked_at IS NULL
           AND notification_authorization IN ('authorized','provisional')
           AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[])) ORDER BY id`,
        [row.principal_id,requestedDeviceIds],
      );
      if (requestedDeviceIds && eligible.rows.length !== requestedDeviceIds.length) {
        await client.query("ROLLBACK");
        return context.json({ ok: false, error: "invalid_device_selection" },400);
      }
      const expiresInSeconds = input.response?.expiresInSeconds;
      const event = await client.query<any>(
        `INSERT INTO notification_events(
           principal_id,service_id,requester_service_id,source,kind,title,body,image_url,deep_link,payload,idempotency_key,
           expires_at,request_hash,target_mode,origin_hash
         ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,
           CASE WHEN $11::int IS NULL THEN NULL ELSE now()+($11*interval '1 second') END,$12,$13,$14)
         ON CONFLICT DO NOTHING RETURNING id,created_at`,
        [row.principal_id,row.id,row.title,
          input.response ? (input.response.type === "approval" ? "approval" : "question") : "notification",
          input.title ?? row.title,content.preview,input.imageUrl ?? row.image_url,
          input.url ?? input.deepLink ?? row.default_url,
          { privacy: "standard", ...(input.response?.correlationId ? { correlationId: input.response.correlationId } : {}) },
          idempotencyKey,expiresInSeconds ?? null,requestHash,
          requestedDeviceIds ? "explicit" : "broadcast",originHash],
      );
      if (!event.rowCount) {
        const existing = await client.query<any>(
          `SELECT e.id,e.created_at,e.request_hash,e.delivery_summary,r.state,r.expires_at
           FROM notification_events e LEFT JOIN interaction_requests r ON r.notification_event_id=e.id
           WHERE e.principal_id=$1 AND e.idempotency_key=$2 AND e.service_id=$3
             AND e.requester_service_id=$3`,
          [row.principal_id,idempotencyKey,row.id],
        );
        if (!existing.rowCount || existing.rows[0].request_hash !== requestHash) {
          await client.query("ROLLBACK");
          return context.json({ ok: false, error: "idempotency_conflict" },409);
        }
        await client.query("COMMIT");
        const delivery = existing.rows[0].delivery_summary ?? { eligibleDevices: eligible.rows.length, durableCommands: 1, apnsJobs: 0 };
        return context.json({
          ok: true,
          eventId: publicId("ntf",existing.rows[0].id),
          delivery,
          queued: delivery.apnsJobs,
          ...(existing.rows[0].expires_at ? { response: {
            status: existing.rows[0].state,
            expiresAt: new Date(existing.rows[0].expires_at).toISOString(),
          } } : {}),
          idempotent: true,
        });
      }
      await persistNotificationContent(client,contentCipher,event.rows[0].id,content);
      let interaction: { id: string; expires_at: Date } | undefined;
      if (input.response) {
        const inserted = await client.query<{ id: string; expires_at: Date }>(
          `INSERT INTO interaction_requests(
             principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at
           ) VALUES ($1,$2,$3,$4,$5,now()+($6*interval '1 second')) RETURNING id,expires_at`,
          [row.principal_id,event.rows[0].id,input.response.type,content.preview,
            hashToken(generateToken()),input.response.expiresInSeconds],
        );
        interaction = inserted.rows[0]!;
        await client.query(
          "UPDATE notification_events SET payload=payload||$2::jsonb WHERE id=$1",
          [event.rows[0].id,{ interactionId: publicId("int",interaction.id), interactionType: input.response.type }],
        );
      }
      assertOrdinaryDeliveryIntentWithinBudget({
        title: input.title ?? row.title, body: content.preview,
        sourceName: row.title,
        conversationId: interaction ? publicId("int",interaction.id) : (originHash ?? publicId("svc",row.id)),
        avatarUrl: row.image_url,
        imageUrl: input.imageUrl ?? row.image_url, deepLink: input.url ?? input.deepLink ?? row.default_url,
        notificationId: publicId("ntf",event.rows[0].id), interactionKind: input.response?.type ?? null,
        payload: {
          privacy: "standard",
          ...(input.response ? {
            interactionType: input.response.type,
            interactionId: interaction ? publicId("int",interaction.id) : undefined,
          } : {}),
        },
      });
      if (requestedDeviceIds) {
        await client.query(
          `INSERT INTO notification_event_targets(notification_event_id,device_id)
           SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
          [event.rows[0].id,requestedDeviceIds],
        );
      }
      const jobs = await client.query(
        `INSERT INTO delivery_jobs(notification_event_id,device_id)
         SELECT $1,d.id FROM devices d WHERE d.principal_id=$2 AND d.revoked_at IS NULL
           AND d.apns_token IS NOT NULL AND d.notification_authorization IN ('authorized','provisional')
           AND ($3::uuid[] IS NULL OR d.id=ANY($3::uuid[]))
         ON CONFLICT DO NOTHING`,
        [event.rows[0].id,row.principal_id,requestedDeviceIds],
      );
      const delivery = { eligibleDevices: eligible.rows.length, durableCommands: 1, apnsJobs: jobs.rowCount ?? 0 };
      await client.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",[event.rows[0].id,delivery]);
      await client.query("COMMIT");
      return context.json({
        ok: true,
        eventId: publicId("ntf",event.rows[0].id),
        delivery,
        queued: jobs.rowCount ?? 0,
        ...(interaction ? { response: {
          status: "pending",
          expiresAt: new Date(interaction.expires_at).toISOString(),
        } } : {}),
        idempotent: false,
      },201);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.get("/hooks/:secret/events/:eventId", async (context) => {
    const secret = context.req.param("secret");
    const eventId = internalId("ntf",context.req.param("eventId") ?? "");
    if (!/^hook_[A-Za-z0-9_-]{43}$/.test(secret) || !eventId) {
      return context.json({ ok: false, error: "event_response_not_found" },404);
    }
    const secretHash = webhookHash(secret);
    await db.query(
      `WITH expired AS (
         UPDATE interaction_requests r SET state='expired',responded_at=now()
         FROM notification_events e,webhook_services s
         WHERE r.notification_event_id=e.id AND e.service_id=s.id
           AND e.id=$1 AND s.secret_hash=$2 AND s.revoked_at IS NULL
           AND r.state='pending' AND r.expires_at<=now()
         RETURNING r.notification_event_id
       )
       UPDATE notification_events SET state='expired',updated_at=now()
       WHERE id IN (SELECT notification_event_id FROM expired)`,
      [eventId,secretHash],
    );
    const result = await db.query<any>(
      `SELECT r.kind,r.state,r.response,r.responded_at,r.expires_at,e.payload,
         count(j.id) FILTER (WHERE j.state IN ('pending','retry','processing'))::int AS queued,
         count(j.id) FILTER (WHERE j.state='accepted')::int AS accepted_by_provider,
         count(j.id) FILTER (WHERE j.state='permanently_failed')::int AS permanently_failed,
         count(j.id) FILTER (WHERE j.state='canceled')::int AS canceled
       FROM interaction_requests r
       JOIN notification_events e ON e.id=r.notification_event_id
       JOIN webhook_services s ON s.id=e.service_id
       LEFT JOIN delivery_jobs j ON j.notification_event_id=e.id
       WHERE e.id=$1 AND s.secret_hash=$2 AND s.revoked_at IS NULL
       GROUP BY r.kind,r.state,r.response,r.responded_at,r.expires_at,e.payload`,
      [eventId,secretHash],
    );
    if (!result.rowCount) return context.json({ ok: false, error: "event_response_not_found" },404);
    const item = result.rows[0]!;
    const binaryActions: Record<string,string> = {
      approved: "approve", denied: "deny", yes: "yes", no: "no",
    };
    const action = item.kind === "text"
      ? (item.state === "replied" ? "reply" : null)
      : (binaryActions[item.state] ?? null);
    const text = item.kind === "text" && item.response
      ? (typeof item.response === "string" ? item.response : item.response.response ?? item.response.value ?? null)
      : null;
    context.header("cache-control","private, no-store");
    return context.json({ ok: true, event: {
      id: publicId("ntf",eventId),
      delivery: {
        queued: item.queued,
        acceptedByProvider: item.accepted_by_provider,
        permanentlyFailed: item.permanently_failed,
        canceled: item.canceled,
      },
      response: {
        status: item.state,
        action,
        text,
        correlationId: item.payload?.correlationId ?? null,
        respondedAt: item.responded_at ? new Date(item.responded_at).toISOString() : null,
        expiresAt: new Date(item.expires_at).toISOString(),
      },
    } });
  });

  app.post("/hooks/:secret/events/:eventId/withdraw", async (context) => {
    const secret = context.req.param("secret");
    const eventId = internalId("ntf",context.req.param("eventId") ?? "");
    if (!/^hook_[A-Za-z0-9_-]{43}$/.test(secret) || !eventId) {
      return context.json({ ok: false,error: "event_not_found" },404);
    }
    const service = await db.query<any>(
      `SELECT * FROM webhook_services WHERE secret_hash=$1 AND revoked_at IS NULL`,
      [webhookHash(secret)],
    );
    if (!service.rowCount) return context.json({ ok: false,error: "event_not_found" },404);
    const limited = await serviceMutationRateLimit(context,db,service.rows[0]);
    if (limited) return limited;
    const idempotencyKey = z.string().trim().min(1).max(200).parse(
      context.req.header("idempotency-key") ?? `server:${randomUUID()}`,
    );
    const row = service.rows[0];
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const event = await client.query<any>(
        `SELECT id,withdrawn_at FROM notification_events
         WHERE id=$1 AND principal_id=$2 AND requester_service_id=$3
           AND kind<>'live_activity' FOR UPDATE`,
        [eventId,row.principal_id,row.id],
      );
      if (!event.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ ok: false,error: "event_not_found" },404);
      }
      if (event.rows[0]!.withdrawn_at) {
        await client.query("COMMIT");
        return context.json({ ok: true,eventId: publicId("ntf",eventId),state: "withdrawn",
          withdrawnAt: event.rows[0]!.withdrawn_at,idempotent: true });
      }
      const withdrawn = await client.query<any>(
        `UPDATE notification_events SET state='withdrawn',withdrawn_at=now(),
           withdrawn_by_kind='service',withdrawn_by_id=$3,updated_at=now()
         WHERE id=$1 AND principal_id=$2 RETURNING withdrawn_at`,
        [eventId,row.principal_id,row.id],
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
         ) VALUES ($1,$2,'service',$3,$4,'canonical_withdrawn')`,
        [row.principal_id,eventId,row.id,idempotencyKey],
      );
      if ((canceled.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO notification_withdrawal_evidence(
             principal_id,notification_event_id,requester_kind,requester_id,idempotency_key,outcome,detail_code
           ) VALUES ($1,$2,'service',$3,$4,'pending_delivery_canceled',$5)`,
          [row.principal_id,eventId,row.id,idempotencyKey,String(canceled.rowCount)],
        );
      }
      await client.query(
        `INSERT INTO notification_withdrawal_evidence(
           principal_id,notification_event_id,device_id,requester_kind,requester_id,
           idempotency_key,outcome,detail_code
         )
         SELECT $1,$2,d.id,'service',$3,$4,'sync_command_queued','inbox_tombstone'
         FROM devices d WHERE d.principal_id=$1 AND d.revoked_at IS NULL`,
        [row.principal_id,eventId,row.id,idempotencyKey],
      );
      await client.query("COMMIT");
      return context.json({ ok: true,eventId: publicId("ntf",eventId),state: "withdrawn",
        withdrawnAt: withdrawn.rows[0]!.withdrawn_at,canceledDeliveries: canceled.rowCount ?? 0,
        idempotent: false });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as any)?.code === "23505") {
        const existing = await db.query<any>(
          `SELECT withdrawn_at FROM notification_events
           WHERE id=$1 AND principal_id=$2 AND requester_service_id=$3`,
          [eventId,row.principal_id,row.id],
        );
        if (existing.rows[0]?.withdrawn_at) return context.json({ ok: true,
          eventId: publicId("ntf",eventId),state: "withdrawn",
          withdrawnAt: existing.rows[0].withdrawn_at,idempotent: true });
      }
      throw error;
    } finally { client.release(); }
  });

  app.post("/hooks/:secret/events/:eventId/cancel", async (context) => {
    const secret = context.req.param("secret");
    const eventId = internalId("ntf",context.req.param("eventId") ?? "");
    if (!/^hook_[A-Za-z0-9_-]{43}$/.test(secret) || !eventId) {
      return context.json({ ok: false, error: "pending_event_response_not_found" },404);
    }
    const service = await serviceForSecret(db,secret);
    if (!service) return context.json({ ok: false, error: "pending_event_response_not_found" },404);
    const limited = await serviceMutationRateLimit(context,db,service);
    if (limited) return limited;
    const result = await db.query<any>(
      `WITH owned AS (
         SELECT e.id FROM notification_events e WHERE e.id=$1 AND e.service_id=$2
       ), canceled AS (
         UPDATE interaction_requests SET state='canceled',responded_at=now()
         WHERE notification_event_id IN (SELECT id FROM owned) AND state='pending'
         RETURNING notification_event_id
       )
       UPDATE notification_events SET state='canceled',updated_at=now()
       WHERE id IN (SELECT notification_event_id FROM canceled) RETURNING id`,
      [eventId,service.id],
    );
    return result.rowCount
      ? context.json({ ok: true, eventId: publicId("ntf",eventId), status: "canceled" })
      : context.json({ ok: false, error: "pending_event_response_not_found" },404);
  });
}
