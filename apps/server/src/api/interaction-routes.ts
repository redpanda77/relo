import { cancelLockedInteraction,expireInteraction,respondToInteraction } from "../interactions/commands.js";
import { createQuestionCardInTransaction } from "../interactions/question-card.js";
import { createNotification,withdrawNotification } from "../notifications/commands.js";
import { ChangeSubscription } from "../interaction-change-hub.js";
import { boundedIntegerQuery } from "../request-bounds.js";
import {  randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {  requireScope } from "../auth.js";
import { internalId, publicId } from "../ids.js";
import { createInteractionSchema,  interactionSchema,  notificationRequestSchema } from "../schemas.js";
import {
  
  markActivityPresentationApplied } from "../activity-presentation-leases.js";

import { lockDecisionActivity } from "../decision-lock.js";

import {  registerInteractionCallback } from "../interaction-callbacks.js";

import { canonicalOriginHash } from "../origin-slots.js";

import {
  
  
  prepareNotificationContent } from "../notification-content.js";
import { requireWorkIdentity,workIdentityError } from "../work-identity.js";
import { stableJson } from "../stable-json.js";

import { jsonBody,selectedDeviceIds,mutationRequestHash,interactionResource,interactionResultSelection } from "./resources.js";
import type { ApiRouteContext } from "./route-context.js";

/** Producer notifications and decisions: send, ask, read, cancel, wait, withdraw and phone responses. */
export function registerNotificationRoutes(app: Hono, shared: ApiRouteContext): void {
  const { db,apnsMode,dependencies,notificationContentCipher,callbackEncryption } = shared;
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
    const identity = requireWorkIdentity(input.sourceName,input.context,input.origin);
    if (!identity.ok) return context.json(workIdentityError(identity.missing),422);
    const originHash = input.origin ? canonicalOriginHash(auth.principalId,input.origin) : null;
    const result = await createNotification(db,{ kind: "credential",principalId: auth.principalId,credentialId: auth.credentialId },{
      idempotencyKey,requestHash,sourceName: input.sourceName,title: input.title,content,
      imageUrl: input.imageUrl ?? null,deepLink: input.destinationUrl ?? null,
      payload: { context: identity.context },deviceIds: requestedDeviceIds,originHash,relevance: input.relevance,
    },{ apnsMode,contentCipher: notificationContentCipher });
    if (result.kind === "invalid_device_selection") return context.json({ error: result.kind },400);
    if (result.kind === "idempotency_conflict") return context.json({ error: result.kind },409);
    return context.json({ eventId: publicId("ntf",result.eventId),createdAt: result.createdAt,
      delivery: result.delivery,queued: result.delivery.apnsJobs,replayed: result.kind === "replayed",relevance: result.relevance },
    result.kind === "created" ? 201 : 200);
  });

  app.post("/api/interactions", requireScope("interactions:create"), async (context) => {
    const parsed = createInteractionSchema.parse(await context.req.json());
    const suppliedKey = context.req.header("idempotency-key");
    const idempotencyKey = suppliedKey === undefined
      ? `server:${randomUUID()}`
      : z.string().trim().min(1).max(200).parse(suppliedKey);
    const requestedDeviceIds = selectedDeviceIds(parsed.deviceIds);
    if (parsed.deviceIds !== undefined && !requestedDeviceIds?.length) return context.json({ error: "invalid_device_selection" },400);
    const requestHash = mutationRequestHash("interaction",{
      input: parsed, deviceIds: requestedDeviceIds ? [...requestedDeviceIds].sort() : null,
    });
    const auth = context.get("auth");
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const identity = requireWorkIdentity(parsed.context?.providerName ?? parsed.title,parsed.context,parsed.origin);
    if (!identity.ok) return context.json(workIdentityError(identity.missing),422);
    const input = { ...parsed,context: identity.context };
    const originHash = input.origin ? canonicalOriginHash(auth.principalId,input.origin) : null;
    const sourceName = input.context?.providerName ?? input.title;
    if (input.presentation === "live_activity") {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const result = await createQuestionCardInTransaction(client,{
          principalId: auth.principalId,sourceId: `credential:${auth.credentialId}`,
          credentialId: auth.credentialId,serviceId: null,
        },input,{ idempotencyKey,requestHash,sourceName,originHash,requestedDeviceIds,
          apnsMode,deliveryApnsMode: dependencies?.apnsMode });
        if (result.kind === "created" && input.callback) await registerInteractionCallback(client,callbackEncryption(),{
          principalId: auth.principalId,interactionRequestId: result.interactionRequestId,...input.callback,correlationId: input.correlationId,
        });
        await client.query(result.commit ? "COMMIT" : "ROLLBACK");
        return result.kind === "rejected" ? context.json(result.body,result.status)
          : context.json(result.body,result.kind === "created" ? 201 : 200);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }
    const result = await createNotification(db,{ kind: "credential",principalId: auth.principalId,credentialId: auth.credentialId },{
      idempotencyKey,requestHash,sourceName,title: input.title,
      content: { ...prepareNotificationContent({ body: input.prompt,
        ...(input.answerInApp ? { summary: "Relo needs you. Open Relo to answer." } : {}) }),
        preview: input.answerInApp ? "Relo needs you. Open Relo to answer." : input.prompt },
      imageUrl: input.imageUrl ?? null,deepLink: input.destinationUrl ?? null,
      payload: { interactionType: input.type,...(input.context ? { context: input.context } : {}),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        ...(input.answerInApp ? { answerInApp: true } : {}) },
      deviceIds: requestedDeviceIds,originHash,relevance: input.relevance,
      interaction: { kind: input.type,prompt: input.prompt,actionSeconds: input.expiresInSeconds },
    },{ apnsMode,contentCipher: notificationContentCipher });
    if (result.kind === "invalid_device_selection") return context.json({ error: result.kind },400);
    if (result.kind === "idempotency_conflict") return context.json({ error: result.kind },409);
    if (!result.interaction) throw new Error("notification_receipt_invalid");
    if (input.callback && result.kind === "created") await registerInteractionCallback(db,callbackEncryption(),{
      principalId: auth.principalId,interactionRequestId: result.interaction.id,...input.callback,correlationId: input.correlationId,
    });
    return context.json({ interaction: { id: publicId("int",result.interaction.id),state: result.interaction.state },
      eventId: publicId("ntf",result.eventId),delivery: result.delivery,queued: result.delivery.apnsJobs,
      replayed: result.kind === "replayed",relevance: result.relevance },result.kind === "created" ? 201 : 200);
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
      await expireInteraction(db,{ kind: "credential",principalId: auth.principalId,credentialId: auth.credentialId },{
        interactionId,eventId: result.rows[0].notification_event_id,
      },apnsMode);
      result = await db.query(select,[interactionId,auth.principalId,auth.credentialId]);
      if (!result.rowCount) return context.json({ error: "not_found" },404);
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
      const select = `${interactionResultSelection}
         WHERE r.id=$1 AND r.principal_id=$2 AND e.requester_credential_id=$3`;
      let result = await client.query<any>(
        select,
        [interactionId,auth.principalId,auth.credentialId],
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "not_found" },404);
      }
      await lockDecisionActivity(client,auth.principalId,result.rows[0].notification_event_id);
      result = await client.query<any>(`${select} FOR UPDATE OF r`,
        [interactionId,auth.principalId,auth.credentialId]);
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
        await cancelLockedInteraction(client,{
          principalId: auth.principalId,interactionId,notificationEventId: row.notification_event_id,
          apnsMode: dependencies?.apnsMode ?? "disabled",
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
    const timeoutSeconds = boundedIntegerQuery(context.req.query("timeoutSeconds"),60,0,300);
    if (timeoutSeconds === null) return context.json({ error: "invalid_timeout" },400);
    const deadline = performance.now() + timeoutSeconds * 1000;
    const subscription = dependencies?.interactionChanges
      ? dependencies.interactionChanges.subscribe(auth.principalId,interactionId,auth.credentialId)
      : new ChangeSubscription();
    if (!subscription) return context.json({ error: "wait_capacity_exceeded" },429);
    try {
      do {
        if (context.req.raw.signal.aborted) return new Response(null,{ status: 499 });
        const result = await db.query<any>(
          `${interactionResultSelection}
           WHERE r.id=$1 AND r.principal_id=$2 AND e.requester_credential_id=$3
             AND EXISTS (SELECT 1 FROM principal_api_keys k WHERE k.id=$3 AND k.revoked_at IS NULL
               AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()))`,
          [interactionId,auth.principalId,auth.credentialId],
        );
        if (!result.rowCount) return context.json({ error: "not_found" }, 404);
        const row = result.rows[0]!;
        if (row.state !== "pending") return context.json({ interaction: interactionResource(row) });
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          await expireInteraction(db,{ kind: "credential",principalId: auth.principalId,credentialId: auth.credentialId },{
            interactionId,eventId: row.notification_event_id,
          },apnsMode);
          const terminal = await db.query(
            `${interactionResultSelection}
             WHERE r.id=$1 AND r.principal_id=$2 AND e.requester_credential_id=$3
               AND EXISTS (SELECT 1 FROM principal_api_keys k WHERE k.id=$3 AND k.revoked_at IS NULL
                 AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()))`,
            [interactionId,auth.principalId,auth.credentialId],
          );
          const winner = terminal.rows[0];
          if (!winner) return context.json({ error: "not_found" },404);
          return context.json({ interaction: interactionResource(winner) });
        }
        if (performance.now() >= deadline) return context.json({ interaction: interactionResource(row) });
        const remaining = Math.max(0,Math.min(5_000,deadline-performance.now(),new Date(row.expires_at).getTime()-Date.now()));
        if (await subscription.wait(remaining,context.req.raw.signal) === "aborted") return new Response(null,{ status: 499 });
      } while (true);
    } finally { subscription.close(); }
  });

  app.post("/api/notifications/:notificationId/withdraw", requireScope("notifications:send"), async (context) => {
    const auth = context.get("auth");
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const eventId = internalId("ntf",context.req.param("notificationId") ?? "");
    if (!eventId) return context.json({ error: "not_found" },404);
    const idempotencyKey = z.string().trim().min(1).max(200).parse(
      context.req.header("idempotency-key") ?? `server:${randomUUID()}`,
    );
    const result = await withdrawNotification(db,{ kind: "credential",principalId: auth.principalId,credentialId: auth.credentialId },{ eventId,idempotencyKey });
    if (result.kind === "not_found") return context.json({ error: "not_found" },404);
    return context.json({ eventId: publicId("ntf",result.eventId),state: "withdrawn",withdrawnAt: result.withdrawnAt,
      ...(!result.replayed ? { canceledDeliveries: result.canceledDeliveries } : {}),replayed: result.replayed });
  });

  app.post("/api/notifications/:notificationId/interactions", requireScope("interactions:respond"), async (context) => {
    const auth = context.get("auth");
    if (!auth.deviceId) return context.json({ error: "device_credential_required" }, 403);
    const eventId = internalId("ntf", context.req.param("notificationId") ?? "");
    if (!eventId) return context.json({ error: "not_found" }, 404);
    const input = await jsonBody(context, interactionSchema);
    if (input.kind !== "received" && input.kind !== "opened") {
      const result = await respondToInteraction(db,{ kind: "device",principalId: auth.principalId,deviceId: auth.deviceId },{
        eventId,interactionId: input.expectedInteractionId ? internalId("int",input.expectedInteractionId) ?? undefined : undefined,
        kind: input.kind,value: input.value,idempotencyKey: input.idempotencyKey,expectedSubject: input.expectedSubject,
      },{ apnsMode });
      if (result.kind === "rejected") return context.json({ error: result.error,...(result.state ? { state: result.state } : {}) },
        result.error === "not_found" || result.error === "interaction_not_found" ? 404 : result.error === "invalid_action" ? 400
          : result.error === "forbidden" ? 403 : result.error === "invalid_credential" ? 401 : 409);
      return context.json({ interactionId: publicId("int",result.evidenceId),replayed: result.kind === "replayed",
        decision: { id: publicId("int",result.interactionId),state: result.state,respondedAt: result.respondedAt } },result.kind === "accepted" ? 201 : 200);
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const event = await client.query<{ id: string;payload: unknown }>(
        `SELECT e.id,e.payload FROM notification_events e WHERE e.id=$1 AND e.principal_id=$3
         AND (e.target_mode='broadcast' OR EXISTS (SELECT 1 FROM notification_event_targets t
           WHERE t.notification_event_id=e.id AND t.device_id=$2))`,[eventId,auth.deviceId,auth.principalId],
      );
      if (!event.rowCount) { await client.query("ROLLBACK");return context.json({ error: "not_found" },404); }
      type ReceiptEvidenceRow = { id: string;notification_event_id: string;interaction_request_id: string | null;
        device_id: string;kind: string;value: unknown };
      const selectEvidence = `SELECT id,notification_event_id,interaction_request_id,device_id,kind,value
        FROM interactions WHERE principal_id=$1 AND idempotency_key=$2`;
      const exact = (row: ReceiptEvidenceRow) => row.notification_event_id === eventId && row.device_id === auth.deviceId
        && row.kind === input.kind && stableJson(row.value) === stableJson(input.value) && row.interaction_request_id === null;
      const replay = (await client.query<ReceiptEvidenceRow>(selectEvidence,[auth.principalId,input.idempotencyKey])).rows[0];
      if (replay) {
        await client.query(exact(replay) ? "COMMIT" : "ROLLBACK");
        return exact(replay) ? context.json({ interactionId: publicId("int",replay.id),replayed: true })
          : context.json({ error: "idempotency_conflict" },409);
      }
      const inserted = (await client.query<{id:string}>(`INSERT INTO interactions(principal_id,notification_event_id,device_id,kind,value,idempotency_key)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (principal_id,idempotency_key) DO NOTHING RETURNING id`,
        [auth.principalId,eventId,auth.deviceId,input.kind,input.value,input.idempotencyKey])).rows[0];
      if (!inserted) {
        const raced = (await client.query<ReceiptEvidenceRow>(selectEvidence,[auth.principalId,input.idempotencyKey])).rows[0];
        const matches = Boolean(raced && exact(raced));await client.query(matches ? "COMMIT" : "ROLLBACK");
        return matches ? context.json({ interactionId: publicId("int",raced!.id),replayed: true })
          : context.json({ error: "idempotency_conflict" },409);
      }
      await client.query("UPDATE notification_events SET updated_at=now() WHERE id=$1 AND principal_id=$2",[eventId,auth.principalId]);
      if (input.kind === "received") {
        const parsed = z.object({ liveActivity: z.object({ activityId: z.string(),operation: z.enum(["start","update","end"]),
          sequence: z.coerce.number().int().nonnegative().refine(Number.isSafeInteger) }) }).safeParse(event.rows[0]!.payload);
        if (parsed.success) {
          const command = parsed.data.liveActivity,activityId = internalId("act",command.activityId);
          if (activityId) await markActivityPresentationApplied(client,{ principalId: auth.principalId,activityId,deviceId: auth.deviceId,
            operation: command.operation,sequence: command.sequence });
        }
      }
      await client.query("COMMIT");
      return context.json({ interactionId: publicId("int",inserted.id),replayed: false },201);
    } catch (error) { await client.query("ROLLBACK");throw error; }
    finally { client.release(); }
  });

}
