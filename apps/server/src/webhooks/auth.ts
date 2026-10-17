import type { Context,Hono } from "hono";
import { matchedRoutes } from "hono/route";
import type { Scope } from "@relo/notification-contracts";
import { resolveService } from "../credentials/service.js";
import { WEBHOOK_SECRET_PATTERN } from "../credentials/hash.js";
import type { Database } from "../db.js";

/**
 * The webhook API's sign-in (plan 10 M3): a service's secret travels only in a header, `Authorization: Bearer
 * hook_…` or `X-Relo-Webhook-Secret`, so proxies, CDNs and access logs never record it (docs/HARDENING.md, gap 7).
 * The middleware resolves the service once (credentials/service.ts: active service, account with access) and
 * every `/hooks` route reads `context.get("webhookService")`; no route sees the secret. A secret in the URL path
 * is refused with the fix in the message; an unknown, rotated or revoked secret, or a disabled account, is
 * `unknown_webhook` on every route.
 */
export type WebhookServiceRow = {
  id: string; principal_id: string; title: string; image_url: string | null; default_url: string | null;
  secret_hash: string; live_activity_policy: unknown;
  /** The owner allows this service to send readable content on an account that requires end-to-end encryption. */
  readable_allowed: boolean;
  scopes: string[];
};

/** The content policy's view of a service (content-policy.ts refuseReadable). */
export const serviceSender = (service: WebhookServiceRow) => ({ kind: "service" as const,readableAllowed: service.readable_allowed });

declare module "hono" {
  interface ContextVariableMap {
    /** The calling service, resolved by `registerWebhookAuth` from its secret header. */
    webhookService: WebhookServiceRow;
  }
}

/**
 * What each webhook route needs (plan 10 A4): the service's scopes (webhook_services.scopes, the hooks:* family of
 * the scope registry). A route that is not listed is closed; webhooks/auth.test.ts fails on one.
 */
export const WEBHOOK_ROUTE_SCOPES: Record<string,Scope> = {
  "POST /hooks": "hooks:notify",
  "POST /hooks/events/:eventId/withdraw": "hooks:notify",
  "POST /hooks/events/:eventId/cancel": "hooks:notify",
  "GET /hooks/events/:eventId": "hooks:read",
  "POST /hooks/live-activities": "hooks:cards",
  "POST /hooks/live-activities/resolve": "hooks:cards",
  "GET /hooks/live-activities/:identifier": "hooks:cards",
  "PATCH /hooks/live-activities/:identifier": "hooks:cards",
  "POST /hooks/live-activities/:identifier/end": "hooks:cards",
  "GET /hooks/works": "hooks:works",
  "POST /hooks/works": "hooks:works",
  "GET /hooks/works/:workId": "hooks:works",
  "PATCH /hooks/works/:workId": "hooks:works",
  "POST /hooks/works/:workId/pause": "hooks:works",
  "POST /hooks/works/:workId/resume": "hooks:works",
  "POST /hooks/works/:workId/finish": "hooks:works",
  "POST /hooks/works/:workId/heartbeat": "hooks:works",
};

export function registerWebhookAuth(app: Hono,db: Database): void {
  const handler = async (context: Context,next: () => Promise<void>) => {
    if (/^\/hooks\/hook_/u.test(new URL(context.req.url).pathname)) {
      return context.json({ ok: false,error: "secret_in_url",
        message: "A service secret never goes in the URL: call <origin>/hooks… with Authorization: Bearer hook_… (or X-Relo-Webhook-Secret), and rotate this secret, since it has been in a URL." },404);
    }
    const bearer = context.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const secret = bearer ?? context.req.header("x-relo-webhook-secret") ?? "";
    const service = WEBHOOK_SECRET_PATTERN.test(secret) ? await resolveService(db,secret) : undefined;
    if (!service) {
      return context.json({ ok: false,error: "unknown_webhook",
        message: "Send an active service's secret in Authorization: Bearer hook_… (or X-Relo-Webhook-Secret)." },404);
    }
    const matched = matchedRoutes(context).filter((route) => route.method !== "ALL").at(-1);
    if (matched) {
      const needed = WEBHOOK_ROUTE_SCOPES[`${matched.method} ${matched.path}`];
      if (!needed || !service.scopes.includes(needed)) {
        return context.json({ ok: false,error: "forbidden",scope: needed ?? null,
          message: needed ? `This service may not do this: it needs the ${needed} scope.` : "This route is not open to services." },403);
      }
    }
    context.set("webhookService",service);
    return next();
  };
  app.use("/hooks/*",handler); // also matches "/hooks" itself
}

/** The ActivityActor a service's card commands run as (its secret's hash is rechecked inside the transaction). */
export function serviceActor(service: WebhookServiceRow) {
  return { kind: "service" as const,principalId: service.principal_id,serviceId: service.id,secretHash: service.secret_hash,sourceName: service.title };
}
