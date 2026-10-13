import { assertQuestionWait } from "./question-wait.js";
import { QuestionWaitTooLongError,questionWaitTooLongBody } from "./question-policy.js";
import { ChoiceUnsupportedError,choiceUnsupportedBody } from "./choice-questions.js";
import type { Hono } from "hono";
import { checkQuestionAnswers,choiceOptionsSchema } from "./question-policy.js";
import { createHash,randomBytes,randomUUID } from "node:crypto";
import { z } from "zod";
import {
activityDeliverySummarySchema,
activityEndSchema,
activityResolveSchema,
activityStartSchema,
activityUpdateSchema,
expireDueActivities,
serializeTaskActivity,
taskActivityRequestHash,
type ApnsMode
} from "./activities.js";
import { questionExpirySchema } from "./question-policy.js";
import { executeActivityCommand } from "./activity-commands/commands.js";
import {
resolveActivityByIdentifier,
resolveActivityReplay,
resolveActivitySelector
} from "./activity-lifecycle-domain.js";
import {
recordActivityCorrelationDecision
} from "./activity-relationships.js";
import { hashToken,requireScope } from "./auth.js";
import type { Database } from "./db.js";
import { internalId,publicId } from "./ids.js";
import { expireInteraction } from "./interactions/commands.js";
import {
MAX_NOTIFICATION_BODY_BYTES,
createNotificationContentCipher,
prepareNotificationContent,
type NotificationContentCipher,
} from "./notification-content.js";
import { createNotification,withdrawNotification } from "./notifications/commands.js";
import {
canonicalOriginHash,
originDescriptorSchema
} from "./origin-slots.js";
import {
ActivityPrivacyPolicyError,
applyActivityPrivacyPolicy,
loadServicePresentationPolicy,
resolveActivityPresentation
} from "./presentation-policy.js";
import {
PresentationRuntimeError,
canonicalPresentation,
persistedPresentationColumns
} from "./presentation-runtime.js";
import { consumeRateLimit } from "./rate-limit.js";
import { decisionSubjectCommandSchema,notificationSubjectCommandSchema } from "./relevance/admission.js";
import { NativeOccurrenceError } from "./relevance/native-occurrence.js";
import { destinationUrlSchema,publicHttpsUrlSchema } from "./url-policy.js";
import { requireWorkIdentity,workIdentityError } from "./work-identity.js";
import { safeContextSchema } from "@relo/notification-contracts";
import { interactionCallbackSchema } from "./schemas.js";
import { callbackResource, registerInteractionCallback } from "./interaction-callbacks.js";
import { createTransportTokenEncryption, type TransportTokenEncryption } from "./token-encryption.js";

const serviceCreateSchema = z.object({
  title: z.string().trim().min(1).max(80),
  imageUrl: publicHttpsUrlSchema.nullable().optional(),
  destinationUrl: destinationUrlSchema.nullable().optional(),
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
  url: destinationUrlSchema.optional(),
  deepLink: destinationUrlSchema.optional(),
  deviceIds: z.array(z.string()).min(1).max(50)
    .transform((values) => [...new Set(values)].sort()).optional(),
  response: z.object({
    type: z.enum(["approval","yes_no","choice"],{ message: "Questions take tappable answers only: approval, yes_no or choice" }),
    options: choiceOptionsSchema.optional(),
    expiresInSeconds: questionExpirySchema,
    correlationId: z.string().trim().min(1).max(100).optional(),
    callback: interactionCallbackSchema.optional(),
  }).strict().superRefine(checkQuestionAnswers).optional(),
  context: safeContextSchema.optional(),
  origin: originDescriptorSchema.optional(),
  relevance: z.union([notificationSubjectCommandSchema,decisionSubjectCommandSchema]).optional(),
}).strict().superRefine((value,context) => {
  if (value.url !== undefined && value.deepLink !== undefined) {
    context.addIssue({ code: "custom", message: "Use url or deepLink, not both." });
  }
  if (value.response && Buffer.byteLength(value.body, "utf8") > 2_000) {
    context.addIssue({ code: "custom", message: "Interactive prompts must be at most 2,000 UTF-8 bytes." });
  }
  if (value.relevance && (value.relevance.policy.kind === "decision") !== Boolean(value.response)) {
    context.addIssue({ code: "custom",message: "Relevance policy must match the notification or response kind" });
  }
  if (value.response && value.relevance?.policy.kind === "decision"
    && value.relevance.policy.actionSeconds !== undefined
    && value.relevance.policy.actionSeconds !== value.response.expiresInSeconds) {
    context.addIssue({ code: "custom",message: "Relevance action duration must match expiresInSeconds" });
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

/** A service sends for its account only while the account has access (ADR 0004: disabling stops it). */
const activeServiceOwner = "JOIN owner_principals service_owner ON service_owner.id=s.principal_id AND service_owner.disabled_at IS NULL";

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
    `SELECT s.* FROM webhook_services s ${activeServiceOwner}
     WHERE s.secret_hash=$1 AND s.revoked_at IS NULL${forUpdate ? " FOR SHARE OF s" : ""}`,
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

/**
 * Webhook secrets may travel in a header instead of the URL path, so proxies, CDNs and access logs
 * never record them (docs/HARDENING.md, gap 7): `POST /hooks` and `/hooks/live-activities…` with
 * `Authorization: Bearer hook_…` (or `X-Relo-Webhook-Secret`) are served exactly like the path form,
 * which stays for compatibility.
 */
function registerHeaderSecretWebhooks(app: Hono): void {
  app.use("/hooks/*",async (context,next) => {
    const url = new URL(context.req.url);
    const headerForm = url.pathname === "/hooks" || url.pathname === "/hooks/" || url.pathname.startsWith("/hooks/live-activities");
    if (!headerForm) return next();
    const bearer = context.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const secret = bearer ?? context.req.header("x-relo-webhook-secret");
    if (!secret || !/^hook_[A-Za-z0-9_-]{43}$/.test(secret)) return context.json({ ok: false,error: "unknown_webhook" },404);
    url.pathname = `/hooks/${secret}${url.pathname.replace(/^\/hooks\/?/,"/").replace(/\/$/,"")}`;
    return app.fetch(await forwarded(context,url),context.env);
  });
}

/** The same request at the path form's URL; the body is read through Hono, which may have read it already. */
async function forwarded(context: { req: { method: string; raw: Request; arrayBuffer: () => Promise<ArrayBuffer> } },url: URL): Promise<Request> {
  const method = context.req.method;
  const init: RequestInit = { method,headers: context.req.raw.headers };
  if (method !== "GET" && method !== "HEAD") init.body = await context.req.arrayBuffer();
  return new Request(url,init);
}

function registerServiceActivityRoutes(app: Hono, db: Database, apnsMode: ApnsMode): void {
  registerHeaderSecretWebhooks(app);
  app.post("/hooks/:secret/live-activities", async (context) => {
    const secret = context.req.param("secret");
    const service = await serviceForSecret(db,secret);
    if (!service) return context.json({ ok: false, error: "unknown_webhook" },404);
    const limited = await serviceMutationRateLimit(context,db,service);
    if (limited) return limited;
    const parsedStart = activityStartSchema.parse(await context.req.json());
    const identity = requireWorkIdentity(`service:${service.id}`,parsedStart.context,parsedStart.origin);
    if (!identity.ok) return context.json({ ok: false,...workIdentityError(identity.missing) },422);
    const rawInput = { ...parsedStart,context: identity.context };
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
    const result=await executeActivityCommand(db,{kind:"service",principalId:service.principal_id,serviceId:service.id,secretHash:webhookHash(secret),sourceName:service.title},{
      operation:"start",source:"producer",rawInput,storedPresentation,presentationPolicy,
      requestedDeviceIds:requestedIds,idempotencyKey:key,requestHash:hash,apnsMode,
    });
    if(result.kind==="start_rejected") return context.json({ok:false,...result.reason},result.category==="invalid"?400:result.category==="missing"?404:409);
    if(result.kind!=="started") throw new Error("activity_start_result_missing");
    return context.json({ok:true,...result.receipt},result.created?201:200);
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
    const resolved = await resolveServiceActivity(db,service.principal_id,service.id,identifier);
    if (!resolved) return context.json({ ok: false, error: "activity_not_found" },404);
    try {
      const result=await executeActivityCommand(db,{kind:"service",principalId:service.principal_id,serviceId:service.id,secretHash:webhookHash(secret),sourceName:service.title},
        {operation:"update",activityId:resolved.id,idempotencyKey:key,requestHash:hash,input,apnsMode,policy:effectivePolicy});
      if(result.kind==="not_found") return context.json({ok: false,error:"activity_not_found"},404);
      if(result.kind==="activity_owner_conflict") return context.json({ok: false,error:result.kind,
        code:"ACTIVITY_OWNER_CONFLICT",disposition:"blocked"},409);
      if(result.kind==="idempotency_conflict") return context.json({ok: false,error:result.kind},409);
      if(result.kind==="activity_terminal"||result.kind==="sequence_conflict")
        return context.json({ok: false,error:result.kind,activity:result.activity},409);
      if(result.kind==="applied"||result.kind==="replayed") return context.json({ok:true,activity:result.activity,
        delivery:result.delivery,queued:result.delivery.apnsJobs,replayed:result.kind==="replayed"});
      throw new Error("unknown_activity_command_result");
    } catch(error) {
      if(error instanceof NativeOccurrenceError) return context.json({ok: false,error:error.code},error.code==="invalid_occurrence"?400:409);
      if(error instanceof PresentationRuntimeError) return context.json({ok: false,error:error.code},409);
      throw error;
    }
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
    const resolved = await resolveServiceActivity(db,service.principal_id,service.id,identifier);
    if (!resolved) return context.json({ ok: false, error: "activity_not_found" },404);
    try {
      const result=await executeActivityCommand(db,{kind:"service",principalId:service.principal_id,serviceId:service.id,secretHash:webhookHash(secret),sourceName:service.title},
        {operation:"end",activityId:resolved.id,idempotencyKey:key,requestHash:hash,input,apnsMode});
      if(result.kind==="not_found") return context.json({ok: false,error:"activity_not_found"},404);
      if(result.kind==="activity_owner_conflict") return context.json({ok: false,error:result.kind,
        code:"ACTIVITY_OWNER_CONFLICT",disposition:"blocked"},409);
      if(result.kind==="idempotency_conflict") return context.json({ok: false,error:result.kind},409);
      if(result.kind==="activity_terminal"||result.kind==="sequence_conflict")
        return context.json({ok: false,error:result.kind,activity:result.activity},409);
      if(result.kind==="applied"||result.kind==="replayed") return context.json({ok:true,activity:result.activity,
        delivery:result.delivery,queued:result.delivery.apnsJobs,replayed:result.kind==="replayed",dismissAfterSeconds:result.dismissAfterSeconds});
      throw new Error("unknown_activity_command_result");
    } catch(error) {
      if(error instanceof NativeOccurrenceError) return context.json({ok: false,error:error.code},error.code==="invalid_occurrence"?400:409);
      if(error instanceof PresentationRuntimeError) return context.json({ok: false,error:error.code},409);
      throw error;
    }
  });
}

type NotificationWebhookServiceRow = { id: string; principal_id: string; title: string; image_url: string | null; default_url: string | null };

export function registerWebhookRoutes(
  app: Hono,
  db: Database,
  apnsMode: ApnsMode = "disabled",
  contentCipher: NotificationContentCipher = createNotificationContentCipher(
    "relo-test-notification-content-secret-v1",
  ),
  callbackEncryption: () => Pick<TransportTokenEncryption,"encrypt"> = () => createTransportTokenEncryption(
    "relo-test-callback-token-secret-v1",
  ),
): void {
  registerServiceActivityRoutes(app,db,apnsMode);
  app.post("/hooks/:secret", async (context) => {
    const secret = context.req.param("secret");
    if (!/^hook_[A-Za-z0-9_-]{43}$/.test(secret)) return context.json({ ok: false, error: "unknown_webhook" }, 404);
    const service = await db.query<NotificationWebhookServiceRow>(
      `SELECT s.* FROM webhook_services s ${activeServiceOwner} WHERE s.secret_hash=$1 AND s.revoked_at IS NULL`,
      [webhookHash(secret)],
    );
    if (!service.rowCount) return context.json({ ok: false, error: "unknown_webhook" }, 404);
    const limited = await serviceMutationRateLimit(context,db,service.rows[0]);
    if (limited) return limited;
    const input = webhookSchema.parse(await context.req.json());
    if (input.response) {
      try { await assertQuestionWait(db,input.response.expiresInSeconds); }
      catch (error) {
        if (error instanceof QuestionWaitTooLongError) return context.json({ ok: false,...questionWaitTooLongBody(error) },400);
        throw error;
      }
    }
    const row = service.rows[0]!;
    const identity = requireWorkIdentity(`service:${row.id}`,input.context && { producerKind: "webhook",...input.context },input.origin);
    if (!identity.ok) return context.json({ ok: false,...workIdentityError(identity.missing) },422);
    const content = prepareNotificationContent(input);
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
    let result: Awaited<ReturnType<typeof createNotification>>;
    try {
    result = await createNotification(db,{ kind: "service",principalId: row.principal_id,serviceId: row.id },{
      idempotencyKey,requestHash,sourceName: row.title,title: input.title ?? row.title,content,
      imageUrl: input.imageUrl ?? row.image_url,deepLink: input.url ?? input.deepLink ?? row.default_url,avatarUrl: row.image_url,
      payload: { privacy: "standard",context: identity.context,...(input.response?.correlationId ? { correlationId: input.response.correlationId } : {}) },
      deviceIds: requestedDeviceIds,originHash,relevance: input.relevance,
      interaction: input.response ? { kind: input.response.type,prompt: content.preview,actionSeconds: input.response.expiresInSeconds,
        options: input.response.options } : undefined,
    },{ apnsMode,contentCipher });
    } catch (error) {
      if (error instanceof ChoiceUnsupportedError) return context.json({ ok: false,...choiceUnsupportedBody(error) },409);
      throw error;
    }
    if (result.kind === "invalid_device_selection") return context.json({ ok: false,error: result.kind },400);
    if (result.kind === "idempotency_conflict") return context.json({ ok: false,error: result.kind },409);
    if (input.response?.callback && result.kind === "created" && result.interaction) {
      await registerInteractionCallback(db,callbackEncryption(),{
        principalId: row.principal_id,interactionRequestId: result.interaction.id,
        ...input.response.callback,correlationId: input.response.correlationId,
      });
    }
    return context.json({ ok: true,eventId: publicId("ntf",result.eventId),delivery: result.delivery,
      queued: result.delivery.apnsJobs,idempotent: result.kind === "replayed",relevance: result.relevance,
      ...(result.interaction ? { response: { status: result.interaction.state,expiresAt: result.interaction.expiresAt.toISOString() } } : {}),
    },result.kind === "created" ? 201 : 200);
  });

  app.get("/hooks/:secret/events/:eventId", async (context) => {
    const secret = context.req.param("secret");
    const eventId = internalId("ntf",context.req.param("eventId") ?? "");
    if (!/^hook_[A-Za-z0-9_-]{43}$/.test(secret) || !eventId) {
      return context.json({ ok: false, error: "event_response_not_found" },404);
    }
    const secretHash = webhookHash(secret);
    const owned = (await db.query<{ id: string; principal_id: string; service_id: string }>(
      `SELECT r.id,r.principal_id,s.id AS service_id FROM interaction_requests r
       JOIN notification_events e ON e.id=r.notification_event_id AND e.principal_id=r.principal_id
       JOIN webhook_services s ON s.id=e.service_id AND s.id=e.requester_service_id
       WHERE e.id=$1 AND s.secret_hash=$2 AND s.revoked_at IS NULL`,[eventId,secretHash],
    )).rows[0];
    if (!owned) return context.json({ ok: false,error: "event_response_not_found" },404);
    await expireInteraction(db,{ kind: "service",principalId: owned.principal_id,serviceId: owned.service_id },{
      interactionId: owned.id,eventId,
    },apnsMode);
    const result = await db.query<any>(
      `SELECT r.kind,r.state,r.response,r.responded_at,r.expires_at,e.payload,
         cb.state AS callback_state,cb.attempts AS callback_attempts,cb.last_status AS callback_last_status,
         cb.last_error AS callback_last_error,cb.delivered_at AS callback_delivered_at,
         count(j.id) FILTER (WHERE j.state IN ('pending','retry','processing'))::int AS queued,
         count(j.id) FILTER (WHERE j.state='accepted')::int AS accepted_by_provider,
         count(j.id) FILTER (WHERE j.state='permanently_failed')::int AS permanently_failed,
         count(j.id) FILTER (WHERE j.state='canceled')::int AS canceled
       FROM interaction_requests r
       JOIN notification_events e ON e.id=r.notification_event_id
       JOIN webhook_services s ON s.id=e.service_id
       LEFT JOIN delivery_jobs j ON j.notification_event_id=e.id
       LEFT JOIN interaction_callbacks cb ON cb.interaction_request_id=r.id
       WHERE e.id=$1 AND s.secret_hash=$2 AND s.revoked_at IS NULL
       GROUP BY r.kind,r.state,r.response,r.responded_at,r.expires_at,e.payload,cb.id`,
      [eventId,secretHash],
    );
    if (!result.rowCount) return context.json({ ok: false, error: "event_response_not_found" },404);
    const item = result.rows[0]!;
    const binaryActions: Record<string,string> = {
      approved: "approve", denied: "deny", yes: "yes", no: "no",
    };
    const chosen = item.kind === "choice" && item.state === "replied" && typeof item.response?.optionId === "string";
    const action = chosen ? "choose" : item.kind === "text"
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
        ...(chosen ? { optionId: item.response.optionId,label: item.response.label ?? null } : {}),
        correlationId: item.payload?.correlationId ?? null,
        respondedAt: item.responded_at ? new Date(item.responded_at).toISOString() : null,
        expiresAt: new Date(item.expires_at).toISOString(),
        callback: callbackResource(item),
      },
    } });
  });

  app.post("/hooks/:secret/events/:eventId/withdraw", async (context) => {
    const secret = context.req.param("secret");
    const eventId = internalId("ntf",context.req.param("eventId") ?? "");
    if (!/^hook_[A-Za-z0-9_-]{43}$/.test(secret) || !eventId) {
      return context.json({ ok: false,error: "event_not_found" },404);
    }
    const service = await db.query<NotificationWebhookServiceRow>(
      `SELECT s.* FROM webhook_services s ${activeServiceOwner} WHERE s.secret_hash=$1 AND s.revoked_at IS NULL`,
      [webhookHash(secret)],
    );
    if (!service.rowCount) return context.json({ ok: false,error: "event_not_found" },404);
    const limited = await serviceMutationRateLimit(context,db,service.rows[0]);
    if (limited) return limited;
    const idempotencyKey = z.string().trim().min(1).max(200).parse(
      context.req.header("idempotency-key") ?? `server:${randomUUID()}`,
    );
    const row = service.rows[0]!;
    const result = await withdrawNotification(db,{ kind: "service",principalId: row.principal_id,serviceId: row.id },{ eventId,idempotencyKey });
    if (result.kind === "not_found") return context.json({ ok: false,error: "event_not_found" },404);
    return context.json({ ok: true,eventId: publicId("ntf",result.eventId),state: "withdrawn",withdrawnAt: result.withdrawnAt,
      ...(!result.replayed ? { canceledDeliveries: result.canceledDeliveries } : {}),idempotent: result.replayed });
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
