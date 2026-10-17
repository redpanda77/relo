import type { Hono } from "hono";
import { z } from "zod";
import { activityDeliverySummarySchema,activityEndSchema,activityResolveSchema,activityStartSchema,activityUpdateSchema,serializeTaskActivity,taskActivityRequestHash,type ApnsMode } from "../activities.js";
import { executeActivityCommand } from "../activity-commands/commands.js";
import { resolveActivityByIdentifier,resolveActivityReplay,resolveActivitySelector } from "../activity-lifecycle-domain.js";
import { recordActivityCorrelationDecision } from "../activity-relationships.js";
import type { Database } from "../db.js";
import { ActivityPrivacyPolicyError,applyActivityPrivacyPolicy,loadServicePresentationPolicy,resolveActivityPresentation } from "../presentation-policy.js";
import { PresentationRuntimeError,canonicalPresentation,persistedPresentationColumns } from "../presentation-runtime.js";
import { NativeOccurrenceError } from "../relevance/native-occurrence.js";
import { requireWorkIdentity,workIdentityError } from "../work-identity.js";
import { refuseReadable } from "../content-policy.js";
import { carriesCardText } from "../end-to-end-policy.js";
import { serviceSender } from "./auth.js";
import { selectedDeviceIds } from "./schemas.js";

/**
 * A service's cards (`/hooks/live-activities…`): start, resolve, read, update and end its own cards. The service is
 * the one `webhooks/auth.ts` resolved from the request's secret header.
 */
type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };

function serviceActivityIdempotencyKey(value: string | undefined): string | undefined {
  return value === undefined ? undefined : z.string().trim().min(1).max(200).parse(value);
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

export function registerServiceCardRoutes(app: Hono, db: Database, apnsMode: ApnsMode): void {
  app.post("/hooks/live-activities", async (context) => {
    const service = context.get("webhookService");
    const parsedStart = activityStartSchema.parse(await context.req.json());
    {
      const refused = await refuseReadable(db,service.principal_id,serviceSender(service));
      if (refused) return context.json({ ok: false,...refused },409);
    }

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
    const result=await executeActivityCommand(db,{kind:"service",principalId:service.principal_id,serviceId:service.id,secretHash:service.secret_hash,sourceName:service.title},{
      operation:"start",source:"producer",rawInput,storedPresentation,presentationPolicy,
      requestedDeviceIds:requestedIds,idempotencyKey:key,requestHash:hash,apnsMode,
    });
    if(result.kind==="start_rejected") return context.json({ok:false,...result.reason},result.category==="invalid"?400:result.category==="missing"?404:409);
    if(result.kind!=="started") throw new Error("activity_start_result_missing");
    return context.json({ok:true,...result.receipt},result.created?201:200);
  });

  app.post("/hooks/live-activities/resolve", async (context) => {
    const service = context.get("webhookService");
    const input = activityResolveSchema.parse(await context.req.json());
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

  app.get("/hooks/live-activities/:identifier", async (context) => {
    const service = context.get("webhookService");
    const activity = await resolveServiceActivity(
      db,service.principal_id,service.id,context.req.param("identifier") ?? "",
    );
    return activity
      ? context.json({ ok: true, activity: serializeTaskActivity(activity) })
      : context.json({ ok: false, error: "activity_not_found" },404);
  });

  app.patch("/hooks/live-activities/:identifier", async (context) => {
    const service = context.get("webhookService");
    const identifier = context.req.param("identifier") ?? "";
    const rawInput = activityUpdateSchema.parse(await context.req.json());
    if (carriesCardText(rawInput)) {
      const refused = await refuseReadable(db,service.principal_id,serviceSender(service));
      if (refused) return context.json({ ok: false,...refused },409);
    }
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
      const result=await executeActivityCommand(db,{kind:"service",principalId:service.principal_id,serviceId:service.id,secretHash:service.secret_hash,sourceName:service.title},
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

  app.post("/hooks/live-activities/:identifier/end", async (context) => {
    const service = context.get("webhookService");
    const identifier = context.req.param("identifier") ?? "";
    const input = activityEndSchema.parse(await context.req.json().catch(() => ({})));
    if (carriesCardText(input)) {
      const refused = await refuseReadable(db,service.principal_id,serviceSender(service));
      if (refused) return context.json({ ok: false,...refused },409);
    }
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
      const result=await executeActivityCommand(db,{kind:"service",principalId:service.principal_id,serviceId:service.id,secretHash:service.secret_hash,sourceName:service.title},
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
