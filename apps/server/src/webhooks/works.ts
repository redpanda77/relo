import type { Context,Hono } from "hono";
import type { ApiRouteContext } from "../api/route-context.js";
import { serviceCardActor } from "../works/card-actor.js";
import { projectWorkCard } from "../works/card-projection.js";
import { refuseReadable } from "../content-policy.js";
import { carriesReadableText,mountProducerWorkRoutes,type ProducerOwner } from "../works/script-routes.js";

/** Same rule as the service module's own `producerKey` column check. */
const PRODUCER_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * Service works (`/hooks/works…`, the secret in a header, STATE-SPEC v2 2.10): webhook-secret producers, readable
 * text only (services cannot seal; on an account that requires end-to-end encryption only with the owner's leave), Idempotency-Key required on creates, leases (2.11). The service is the one
 * `webhooks/auth.ts` resolved from the secret header (an unknown or revoked secret never reaches these routes).
 * A service work's card is projected like a script's, through the service's CardActor (plan 10 M5).
 */
export function registerServiceWorkRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db,apnsMode,notificationContentCipher } = shared;

  async function resolve(context: Context): Promise<ProducerOwner | Response> {
    const service = context.get("webhookService");
    let producerKey = context.req.query("producerKey") ?? "";
    const isStart = context.req.method === "POST" && /\/works\/?$/.test(new URL(context.req.url).pathname);
    if (isStart) {
      try { producerKey = String(((await context.req.json()) as { producerKey?: unknown }).producerKey ?? ""); } catch { producerKey = ""; }
      if (!PRODUCER_KEY_PATTERN.test(producerKey)) {
        return context.json({ error: "invalid_producer_key",message: "Send producerKey (1-100 of A-Z a-z 0-9 . _ : -) with every start." },400);
      }
    } else if (producerKey && !PRODUCER_KEY_PATTERN.test(producerKey)) {
      return context.json({ error: "invalid_producer_key",message: "producerKey is 1-100 of A-Z a-z 0-9 . _ : -." },400);
    }
    return { producerType: "service",principalId: service.principal_id,serviceId: service.id,producerKey,sourceName: service.title,
      card: serviceCardActor(db,service),readableAllowed: service.readable_allowed };
  }

  mountProducerWorkRoutes(app,"/hooks",db,resolve,async (owner,work) => projectWorkCard(db,apnsMode,owner.card,work),
    async (owner,input) => {
      // A service cannot seal: its readable work text follows the account's content policy and the owner's choice for it.
      if (owner.producerType !== "service" || !input || typeof input !== "object" || !carriesReadableText(input as Record<string,unknown>)) return null;
      const refused = await refuseReadable(db,owner.principalId,{ kind: "service",readableAllowed: owner.readableAllowed === true });
      return refused ? { status: 409,body: { ok: false,...refused } } : null;
    },notificationContentCipher ? { apnsMode,contentCipher: notificationContentCipher } : undefined);
}
