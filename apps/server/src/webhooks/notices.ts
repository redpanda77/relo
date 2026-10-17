import { assertQuestionWait } from "../question-wait.js";
import { QuestionWaitTooLongError,questionWaitTooLongBody } from "../question-policy.js";
import { ChoiceUnsupportedError,choiceUnsupportedBody } from "../choice-questions.js";
import type { Hono } from "hono";
import { createHash,randomBytes,randomUUID } from "node:crypto";
import { z } from "zod";
import { type ApnsMode } from "../activities.js";
import type { Database } from "../db.js";
import { internalId,publicId } from "../ids.js";
import { expireInteraction } from "../interactions/commands.js";
import { createNotificationContentCipher,prepareNotificationContent,type NotificationContentCipher } from "../notification-content.js";
import { createNotification,withdrawNotification } from "../notifications/commands.js";
import { canonicalOriginHash } from "../origin-slots.js";
import { requireWorkIdentity,workIdentityError } from "../work-identity.js";
import { callbackResource,registerInteractionCallback } from "../interaction-callbacks.js";
import { createTransportTokenEncryption,type TransportTokenEncryption } from "../token-encryption.js";
import { refuseReadable } from "../content-policy.js";
import { serviceSender } from "./auth.js";
import { selectedDeviceIds,webhookSchema } from "./schemas.js";

/**
 * A service's notices and questions (`POST /hooks`) and its events (`/hooks/events/:eventId…`: read the answer,
 * withdraw, cancel). The service is the one `webhooks/auth.ts` resolved from the request's secret header.
 */
function webhookRequestHash(value: z.infer<typeof webhookSchema>): string {
  return createHash("sha256").update(`relo:webhook-request:v1\n${JSON.stringify(value)}`).digest("hex");
}



export function registerServiceNoticeRoutes(
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
  app.post("/hooks", async (context) => {
    const row = context.get("webhookService");
    const input = webhookSchema.parse(await context.req.json());
    // A service cannot seal: every notice it sends is readable.
    {
      const refused = await refuseReadable(db,row.principal_id,serviceSender(row));
      if (refused) return context.json({ ok: false,...refused },409);
    }
    if (input.response) {
      try { await assertQuestionWait(db,input.response.expiresInSeconds); }
      catch (error) {
        if (error instanceof QuestionWaitTooLongError) return context.json({ ok: false,...questionWaitTooLongBody(error) },400);
        throw error;
      }
    }
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

  app.get("/hooks/events/:eventId", async (context) => {
    const service = context.get("webhookService");
    const eventId = internalId("ntf",context.req.param("eventId") ?? "");
    if (!eventId) return context.json({ ok: false, error: "event_response_not_found" },404);
    const owned = (await db.query<{ id: string; principal_id: string; service_id: string }>(
      `SELECT r.id,r.principal_id,s.id AS service_id FROM interaction_requests r
       JOIN notification_events e ON e.id=r.notification_event_id AND e.principal_id=r.principal_id
       JOIN webhook_services s ON s.id=e.service_id AND s.id=e.requester_service_id
       WHERE e.id=$1 AND s.id=$2`,[eventId,service.id],
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
       WHERE e.id=$1 AND s.id=$2
       GROUP BY r.kind,r.state,r.response,r.responded_at,r.expires_at,e.payload,cb.id`,
      [eventId,service.id],
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

  app.post("/hooks/events/:eventId/withdraw", async (context) => {
    const row = context.get("webhookService");
    const eventId = internalId("ntf",context.req.param("eventId") ?? "");
    if (!eventId) return context.json({ ok: false,error: "event_not_found" },404);
    const idempotencyKey = z.string().trim().min(1).max(200).parse(
      context.req.header("idempotency-key") ?? `server:${randomUUID()}`,
    );
    const result = await withdrawNotification(db,{ kind: "service",principalId: row.principal_id,serviceId: row.id },{ eventId,idempotencyKey });
    if (result.kind === "not_found") return context.json({ ok: false,error: "event_not_found" },404);
    return context.json({ ok: true,eventId: publicId("ntf",result.eventId),state: "withdrawn",withdrawnAt: result.withdrawnAt,
      ...(!result.replayed ? { canceledDeliveries: result.canceledDeliveries } : {}),idempotent: result.replayed });
  });

  app.post("/hooks/events/:eventId/cancel", async (context) => {
    const service = context.get("webhookService");
    const eventId = internalId("ntf",context.req.param("eventId") ?? "");
    if (!eventId) return context.json({ ok: false, error: "pending_event_response_not_found" },404);
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
