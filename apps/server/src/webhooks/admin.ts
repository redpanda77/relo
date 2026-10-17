import type { Hono } from "hono";
import { requireScope } from "../auth.js";
import type { Database } from "../db.js";
import { internalId,publicId } from "../ids.js";
import { createService,revokeService,rotateService,serviceCredential } from "../credentials/service.js";
import { serviceCreateSchema,serviceUpdateSchema } from "./schemas.js";

/**
 * Service management (`/api/services…` for a login with `services:*`; the Dashboard's routes call the same
 * functions). The secret itself is minted, rotated and revoked by `credentials/service.ts`.
 */
/** Creates a service for an account and returns it with the endpoint and its one-time secret. */
export async function createWebhookService(
  db: Database,
  principalId: string,
  title: string,
  appUrl: string,
  defaults?: { imageUrl?: string | null | undefined; destinationUrl?: string | null | undefined; readableAllowed?: boolean | undefined; scopes?: string[] | undefined },
) {
  const { row,secret } = await createService(db,{ principalId,title,...defaults });
  return { row, ...serviceCredential(appUrl,secret) };
}

/** A new secret for an active service, with the endpoint; null when the service is unknown or revoked. */
export async function rotateWebhookService(db: Database, principalId: string, serviceId: string, appUrl: string) {
  const rotated = await rotateService(db,principalId,serviceId);
  return rotated ? { row: rotated.row, ...serviceCredential(appUrl,rotated.secret) } : null;
}

/** One update for the API and the Dashboard: only the fields given change. Null when unknown or revoked. */
export async function updateWebhookService(db: Database,principalId: string,serviceId: string,input: {
  title?: string | undefined; imageUrl?: string | null | undefined; destinationUrl?: string | null | undefined;
  readableAllowed?: boolean | undefined; scopes?: string[] | undefined;
}): Promise<any | null> {
  const result = await db.query<any>(
    `UPDATE webhook_services SET
       title=CASE WHEN $3::boolean THEN $4 ELSE title END,
       image_url=CASE WHEN $5::boolean THEN $6 ELSE image_url END,
       default_url=CASE WHEN $7::boolean THEN $8 ELSE default_url END,
       readable_allowed=COALESCE($9::boolean,readable_allowed),
       scopes=COALESCE($10::text[],scopes),
       updated_at=now()
     WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING *`,
    [serviceId,principalId,
      input.title !== undefined,input.title ?? null,
      input.imageUrl !== undefined,input.imageUrl ?? null,
      input.destinationUrl !== undefined,input.destinationUrl ?? null,
      input.readableAllowed ?? null,input.scopes ?? null],
  );
  return result.rows[0] ?? null;
}

export function serviceResource(row: any) {
  return {
    id: publicId("svc",row.id),
    title: row.title,
    imageUrl: row.image_url,
    destinationUrl: row.default_url,
    prefix: row.secret_prefix,
    readableAllowed: row.readable_allowed === true,
    scopes: row.scopes ?? [],
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
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
    const { title,...defaults } = input;
    const created = await createWebhookService(db,auth.principalId,title,publicOrigin,defaults);
    return context.json({ service: serviceResource(created.row), endpoint: created.endpoint, secret: created.secret },201);
  });

  app.patch("/api/services/:serviceId", requireScope("services:write"), async (context) => {
    const auth = context.get("auth");
    const serviceId = internalId("svc",context.req.param("serviceId") ?? "");
    if (!serviceId) return context.json({ error: "not_found" },404);
    const input = serviceUpdateSchema.parse(await context.req.json());
    const row = await updateWebhookService(db,auth.principalId,serviceId,input);
    return row ? context.json({ service: serviceResource(row) }) : context.json({ error: "not_found" },404);
  });

  app.post("/api/services/:serviceId/rotate", requireScope("services:write"), async (context) => {
    const auth = context.get("auth");
    const serviceId = internalId("svc",context.req.param("serviceId") ?? "");
    if (!serviceId) return context.json({ error: "not_found" },404);
    const publicOrigin = appUrl ?? new URL(context.req.url).origin;
    const rotated = await rotateWebhookService(db,auth.principalId,serviceId,publicOrigin);
    return rotated
      ? context.json({ service: serviceResource(rotated.row), endpoint: rotated.endpoint, secret: rotated.secret })
      : context.json({ error: "not_found" },404);
  });

  app.delete("/api/services/:serviceId", requireScope("services:write"), async (context) => {
    const auth = context.get("auth");
    const serviceId = internalId("svc",context.req.param("serviceId") ?? "");
    if (!serviceId) return context.json({ error: "not_found" },404);
    return await revokeService(db,auth.principalId,serviceId) ? context.json({ ok: true }) : context.json({ error: "not_found" },404);
  });
}

declare module "hono" {
  interface ContextVariableMap {
    /** The calling service's secret, read from its header by `registerWebhookSecret` (never from the URL). */
    webhookSecret: string;
  }
}
