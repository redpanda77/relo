import { effectiveComputerIcon } from "./computers/store.js";
import { checkSealedCard,sealedQuestionRequest,unsignedSealed,withUnsignedSealed } from "./sealed-content.js";
import { recordQuestionOnWork } from "./works/questions.js";
import { refuseReadable } from "./content-policy.js";
import { carriesCardText } from "./end-to-end-policy.js";
import { continueQuestionBeyondCard } from "./activity-commands/long-question.js";
import { assertQuestionWait } from "./question-wait.js";
import { QUESTION_SECONDS,QuestionWaitTooLongError,questionWaitTooLongBody } from "./question-policy.js";
import { choiceUnsupportedBody } from "./choice-questions.js";
import {
type RelevanceItem
} from "@relo/notification-contracts";
import { Hono } from "hono";
import { z } from "zod";
import { executeActivityCommand } from "./activity-commands/commands.js";
import { serializeTaskActivity,taskActivityRequestHash } from "./activity-commands/runtime.js";
import { notifyQuestionFallback } from "./activity-commands/question-fallback.js";
import type { NotificationContentCipher } from "./notification-content.js";
import { foldQuestionIntoCard } from "./activity-commands/fold-question.js";
import { registerInteractionCallback } from "./interaction-callbacks.js";
import { createTransportTokenEncryption,type TransportTokenEncryption } from "./token-encryption.js";
import type { ActivityDeliverySummary,ApnsMode } from "./activity-commands/schemas.js";
import { activityDeliverySummarySchema,activityEndSchema,activityHeartbeatSchema,activityResolveSchema,activityStartSchema,activityUpdateSchema,activityWaitSchema } from "./activity-commands/schemas.js";
import {
beginActivityTransaction,
lifecycleMutationAllowed,
resolveActivityByIdentifier,
resolveActivityReplay,
resolveActivitySelector
} from "./activity-lifecycle-domain.js";
import type { Database } from "./db.js";
import { internalId,publicId } from "./ids.js";
import { registerPresentationRoutes } from "./presentation-assets.js";
import {
ActivityPrivacyPolicyError,
applyActivityPrivacyPolicy,
loadClientPresentationPolicy,
resolveActivityPresentation
} from "./presentation-policy.js";
import {
PresentationRuntimeError,
canonicalPresentation,
persistedPresentationColumns
} from "./presentation-runtime.js";
import { NativeOccurrenceError } from "./relevance/native-occurrence.js";
import { requireWorkIdentity,workIdentityError } from "./work-identity.js";
export { activityProviderTimestamp,activityStartedAt,boundedPresentationText,cancelPendingActivityInteractions,createActivityCommands,replaceBlockingTaskActivities,serializeTaskActivity,taskActivityRequestHash } from "./activity-commands/runtime.js";
export { activityDeliverySummarySchema,activityEndSchema,activityHeartbeatSchema,activityResolveSchema,activityStartSchema,activityUpdateSchema,activityWaitSchema,liveActivityStyles,liveActivitySymbols,taskLiveActivityStyles } from "./activity-commands/schemas.js";
export type { ActivityDeliverySummary,ApnsMode } from "./activity-commands/schemas.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };
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

type ActivityWaitReplayRow = {
  relevance: RelevanceItem | null;
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
       r.prompt AS interaction_prompt,r.state AS interaction_state,r.expires_at AS interaction_expires_at,
       nr.relevance
     FROM live_activity_operations o
     JOIN interaction_requests r ON r.id=COALESCE(o.interaction_request_id,(
       SELECT r2.id FROM notification_events e2 JOIN interaction_requests r2 ON r2.notification_event_id=e2.id
       WHERE e2.principal_id=o.principal_id AND e2.requester_credential_id=o.requester_credential_id
         AND e2.idempotency_key=o.idempotency_key LIMIT 1))
     JOIN notification_events e ON e.id=r.notification_event_id
     LEFT JOIN notification_relevance nr ON nr.notification_event_id=e.id
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
    eventId,delivery,queued: delivery.apnsJobs,relevance: row.relevance,
    deliveryMode: apnsMode !== "disabled" && delivery.apnsJobs > 0
      ? "queued_for_direct_apns"
      : "durable_inbox_refresh_only",
    replayed,
  };
}

export function registerActivityRoutes(app: Hono, db: Database, apnsMode: ApnsMode,
  dependencies: { contentCipher?: NotificationContentCipher | null;
    callbackEncryption?: () => Pick<TransportTokenEncryption,"encrypt"> } = {}): void {
  registerPresentationRoutes(app,db);

  app.post("/api/live-activities", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:write")) return context.json({ error: "forbidden" },403);
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const parsedStart = activityStartSchema.parse(await context.req.json());
    if (checkSealedCard(parsedStart.sealed)?.ok === false) return context.json({ error: "invalid_sealed_content" },400);
    if (!parsedStart.sealed) { const refused = await refuseReadable(db,auth.principalId); if (refused) return context.json(refused,409); }
    const identity = requireWorkIdentity(`credential:${auth.credentialId}`,parsedStart.context,parsedStart.origin);
    if (!identity.ok) return context.json(workIdentityError(identity.missing),422);
    const rawInput = { ...parsedStart,context: identity.context };
    const effectivePolicy = await loadClientPresentationPolicy(
      db,auth.principalId,auth.credentialId,
    );
    let storedPresentation: ReturnType<typeof persistedPresentationColumns>;
    let presentationPolicy: ReturnType<typeof resolveActivityPresentation>["snapshot"];
    try {
      const resolved = resolveActivityPresentation(rawInput,{
        principalId: auth.principalId,effective: effectivePolicy,
        computerIcon: await effectiveComputerIcon(db,auth.credentialId),
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
      ...withUnsignedSealed(rawInput),
      deviceIds: rawInput.deviceIds ? [...rawInput.deviceIds].sort() : undefined,
    });
    const result=await executeActivityCommand(db,{kind:"credential",principalId:auth.principalId,credentialId:auth.credentialId,sourceName:auth.clientName??"Relo CLI"},{
      operation:"start",source:"producer",rawInput,storedPresentation,presentationPolicy,
      requestedDeviceIds:requestedIds,idempotencyKey:key,requestHash:hash,apnsMode,
    });
    if(result.kind==="start_rejected") return context.json({...result.reason},result.category==="invalid"?400:result.category==="missing"?404:409);
    if(result.kind!=="started") throw new Error("activity_start_result_missing");
    return context.json({...result.receipt},result.created?201:200);
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
      // A write past expires_at (or a provider's lease) continues the card: time never ends work.
      if (current.state !== "active") {
        await transaction.rollback();
        return context.json({ error: "activity_terminal",activity: serializeTaskActivity(current) },409);
      }
      const renewed = (await client.query<any>(
        `UPDATE live_activities
         SET stale_after_seconds=$3::integer,stale_at=LEAST(statement_timestamp()+($3::integer*interval '1 second'),expires_at),updated_at=statement_timestamp()
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
    if (checkSealedCard(rawInput.sealed)?.ok === false) return context.json({ error: "invalid_sealed_content" },400);
    if (!rawInput.sealed && carriesCardText(rawInput)) {
      const refused = await refuseReadable(db,auth.principalId);
      if (refused) return context.json(refused,409);
    }
    const key = idempotencyKey(context.req.header("idempotency-key"));
    let hashInput: unknown = withUnsignedSealed(rawInput);
    try {
      if (rawInput.presentation) {
        hashInput = { ...withUnsignedSealed(rawInput),presentation: canonicalPresentation(rawInput.presentation) };
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

    try {
      const result=await executeActivityCommand(db,{kind:"credential",principalId:auth.principalId,credentialId:auth.credentialId,sourceName:auth.clientName??"Relo CLI"},
        {operation:"update",activityId:activityId,idempotencyKey:key,requestHash:hash,input,apnsMode,policy:effectivePolicy,
          computerIcon:await effectiveComputerIcon(db,auth.credentialId)});
      if(result.kind==="not_found") return context.json({error:"not_found"},404);
      if(result.kind==="activity_owner_conflict") return context.json({error:result.kind,
        code:"ACTIVITY_OWNER_CONFLICT",disposition:"blocked"},409);
      if(result.kind==="idempotency_conflict") return context.json({error:result.kind},409);
      if(result.kind==="activity_terminal"||result.kind==="sequence_conflict")
        return context.json({error:result.kind,activity:result.activity},409);
      if(result.kind==="applied"||result.kind==="replayed") return context.json({activity:result.activity,
        delivery:result.delivery,queued:result.delivery.apnsJobs,replayed:result.kind==="replayed"});
      throw new Error("unknown_activity_command_result");
    } catch(error) {
      if(error instanceof NativeOccurrenceError) return context.json({error:error.code},error.code==="invalid_occurrence"?400:409);
      if(error instanceof PresentationRuntimeError) return context.json({error:error.code},409);
      throw error;
    }
  });

  // A question asked on a card folds into that card: the card switches to "Needs you"
  // with the answer buttons and an alert, then returns to the work once settled.
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
    const raw = await context.req.json();
    // A sealed question carries no readable prompt (E4.1): the card shows a placeholder.
    const sealedRequest = sealedQuestionRequest(raw,{ title: false });
    if (sealedRequest && "error" in sealedRequest) return context.json({ error: sealedRequest.error },400);
    const input = activityWaitSchema.parse(sealedRequest ? sealedRequest.body : raw);
    const sealedQuestion = sealedRequest?.sealed ?? null;
    if (!sealedQuestion) { const refused = await refuseReadable(db,auth.principalId); if (refused) return context.json(refused,409); }
    try { await assertQuestionWait(db,input.expiresInSeconds); }
    catch (error) { if (error instanceof QuestionWaitTooLongError) return context.json(questionWaitTooLongBody(error),400); throw error; }
    const hash = taskActivityRequestHash("wait",{ activityId: externalActivityId,...input,
      ...(sealedQuestion ? { sealed: unsignedSealed(sealedQuestion) } : {}) });
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
        `SELECT *,expires_at<=clock_timestamp() AS deadline_passed FROM live_activities
         WHERE id=$1 AND principal_id=$2 AND requester_credential_id=$3
           AND requester_service_id IS NULL FOR UPDATE`,
        [activityId,auth.principalId,auth.credentialId],
      );
      if (!parent.rowCount) {
        await transaction.rollback();
        return context.json({ error: "not_found" },404);
      }
      const parentRow = parent.rows[0]!;
      if (parentRow.state !== "active" || parentRow.deadline_passed) {
        await transaction.rollback();
        return context.json({ error: "activity_not_active" },409);
      }
      const folded = await foldQuestionIntoCard(client,{
        principalId: auth.principalId,row: parentRow,apnsMode,fallbackSourceName: auth.clientName ?? "Relo CLI",
        contentCipher: dependencies.contentCipher,
        question: { type: input.type,prompt: input.prompt,detail: input.detail,options: input.options,expiresInSeconds: input.expiresInSeconds,
          primaryLabel: input.primaryLabel,secondaryLabel: input.secondaryLabel,sealed: sealedQuestion },
      });
      if (folded.kind !== "folded") {
        await transaction.rollback();
        return folded.kind === "question_pending"
          ? context.json({ error: "question_pending",
              message: "This card is already waiting for an answer. Wait for it, or cancel it first." },409)
          : folded.kind === "choice_unsupported"
            ? context.json(choiceUnsupportedBody(folded.error),409)
          : folded.kind === "content_encryption_unavailable"
            ? context.json({ error: "content_encryption_unavailable" },503)
          : folded.kind === "private_activity_question"
            ? context.json({ error: "private_activity_question",message: "A private card cannot show a question." },409)
            : context.json({ error: "activity_target_unavailable" },409);
      }
      const updated = { rows: [folded.activity] };
      const delivery = folded.delivery;
      // A question on a work's card attaches to that work (never ends it).
      await recordQuestionOnWork(client,parentRow,folded.interactionRequestId);
      // Asked to wait past the usual 5 minutes and longer than the card lives: the same decision keeps
      // waiting in Relo after the card ends. A usual question still ends with its card.
      const cardSeconds = Math.floor((new Date(parentRow.expires_at).getTime()-Date.now())/1_000);
      const longer = input.expiresInSeconds > QUESTION_SECONDS && input.expiresInSeconds > cardSeconds
        && dependencies.contentCipher;
      const request = { rows: [{ id: longer
        ? await continueQuestionBeyondCard(client,{ principalId: auth.principalId,credentialId: auth.credentialId,
            card: folded.activity,idempotencyKey: key,sourceName: auth.clientName ?? "Relo CLI",apnsMode,
            contentCipher: dependencies.contentCipher!,
            question: { type: input.type,prompt: input.prompt,detail: input.detail,options: input.options,
              expiresInSeconds: input.expiresInSeconds,sealed: sealedQuestion } })
        : folded.interactionRequestId }] };
      await client.query(
        `INSERT INTO live_activity_operations(
           live_activity_id,principal_id,requester_credential_id,idempotency_key,operation,
           resulting_sequence,request_hash,delivery_summary,activity_snapshot,interaction_request_id
         ) VALUES ($1,$2,$3,$4,'wait',$5,$6,$7,$8,$9)`,
        [activityId,auth.principalId,auth.credentialId,key,updated.rows[0]!.sequence,hash,delivery,
          serializeTaskActivity(updated.rows[0]!),request.rows[0]!.id],
      );
      if (input.callback) {
        await registerInteractionCallback(client,dependencies.callbackEncryption?.() ?? createTransportTokenEncryption(
          "relo-test-callback-token-secret-v1"),{ principalId: auth.principalId,interactionRequestId: request.rows[0]!.id,
          ...input.callback,correlationId: input.correlationId });
      }
      const created = await activityWaitReplay(client,auth.principalId,auth.credentialId,activityId,key);
      if (!created) throw new Error("activity wait persistence failed");
      await transaction.commit();
      // The phone cannot show this card (Live Activities off or no start token): say so plainly.
      if (apnsMode !== "disabled" && delivery.eligibleDevices > 0 && delivery.apnsJobs === 0) {
        await notifyQuestionFallback(db,{ principalId: auth.principalId,activityId,apnsMode,
          contentCipher: dependencies.contentCipher });
      }
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
    if (checkSealedCard(input.sealed)?.ok === false) return context.json({ error: "invalid_sealed_content" },400);
    if (!input.sealed && carriesCardText(input)) {
      const refused = await refuseReadable(db,auth.principalId);
      if (refused) return context.json(refused,409);
    }
    const key = idempotencyKey(context.req.header("idempotency-key"));
    let hashInput: unknown = withUnsignedSealed(input);
    try {
      if (input.presentation) hashInput = { ...withUnsignedSealed(input),presentation: canonicalPresentation(input.presentation) };
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

    try {
      const result=await executeActivityCommand(db,{kind:"credential",principalId:auth.principalId,credentialId:auth.credentialId,sourceName:auth.clientName??"Relo CLI"},
        {operation:"end",activityId:activityId,idempotencyKey:key,requestHash:hash,input,apnsMode});
      if(result.kind==="not_found") return context.json({error:"not_found"},404);
      if(result.kind==="activity_owner_conflict") return context.json({error:result.kind,
        code:"ACTIVITY_OWNER_CONFLICT",disposition:"blocked"},409);
      if(result.kind==="idempotency_conflict") return context.json({error:result.kind},409);
      if(result.kind==="activity_terminal"||result.kind==="sequence_conflict")
        return context.json({error:result.kind,activity:result.activity},409);
      if(result.kind==="applied"||result.kind==="replayed") return context.json({activity:result.activity,
        delivery:result.delivery,queued:result.delivery.apnsJobs,replayed:result.kind==="replayed",dismissAfterSeconds:result.dismissAfterSeconds});
      throw new Error("unknown_activity_command_result");
    } catch(error) {
      if(error instanceof NativeOccurrenceError) return context.json({error:error.code},error.code==="invalid_occurrence"?400:409);
      if(error instanceof PresentationRuntimeError) return context.json({error:error.code},409);
      throw error;
    }
  });

  app.post("/api/live-activities/resolve", async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:read")) return context.json({ error: "forbidden" },403);
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const input = activityResolveSchema.parse(await context.req.json());
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
    const row = await resolveOwnedActivity(db,auth.principalId,context.req.param("activityId") ?? "",false,auth.credentialId);
    return row ? context.json({ activity: serializeTaskActivity(row) }) : context.json({ error: "not_found" },404);
  });
}
