import type { Context,Hono } from "hono";
import type { ApiRouteContext } from "../api/route-context.js";
import { hashToken } from "../auth.js";
import { mountProducerWorkRoutes,type ProducerOwner } from "./script-routes.js";

/** Same rule as the service module's own `producerKey` column check. */
const PRODUCER_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const SECRET_PATTERN = /^hook_[A-Za-z0-9_-]{43}$/;
const NOT_FOUND = { error: "not_found" } as const;

/**
 * Service works (`/hooks/:secret/works…`, STATE-SPEC v2 2.10): webhook-secret producers, readable
 * text only (services cannot seal), Idempotency-Key required on creates, leases (2.11). Registered
 * before `authenticate`, like the other `/hooks/*` routes. A revoked or unknown secret is 404 everywhere.
 * TODO(2.10 rest): scopes column (`webhook_services.scopes`) is not migrated yet, so every scope is
 * granted; questions/answers/notices/feed routes and the service card projection (needs a service
 * actor in `card-projection.ts`) are not built here.
 */
export function registerServiceWorkRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db } = shared;

  async function resolve(context: Context): Promise<ProducerOwner | Response> {
    const secret = context.req.param("secret") ?? "";
    if (!SECRET_PATTERN.test(secret)) return context.json(NOT_FOUND,404);
    const service = (await db.query<{ id: string; principal_id: string; title: string }>(
      `SELECT s.id,s.principal_id,s.title FROM webhook_services s
         JOIN owner_principals p ON p.id=s.principal_id AND p.disabled_at IS NULL
       WHERE s.secret_hash=$1 AND s.revoked_at IS NULL`,[hashToken(`relo:webhook:v1\n${secret}`)])).rows[0];
    if (!service) return context.json(NOT_FOUND,404);
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
    return { producerType: "service",principalId: service.principal_id,serviceId: service.id,producerKey,sourceName: service.title };
  }

  // TODO(card projection owner): project service works onto cards once card-projection accepts a service actor.
  mountProducerWorkRoutes(app,"/hooks/:secret",db,resolve,async () => undefined);
}
