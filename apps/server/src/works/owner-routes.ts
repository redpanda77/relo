import type { Hono } from "hono";
import type { ApiRouteContext } from "../api/route-context.js";
import { SESSION_KEY_HEADER } from "./session-routes.js";
import { activeCardFor,readOwnerWork,readOwnerWorks,serializeWork,workInternalId } from "./store.js";

const OWNER_ONLY = {
  error: "owner_only",
  message: "This lists every session; it is for the owner.",
  next: "relo state",
} as const;

/**
 * Owner reads of works (phones, linked browsers, Dashboard, owner API keys). Cross-session views are
 * the owner's: a caller that names an agent session is refused. The producer's own sealed copy is
 * never served here.
 */
export function registerOwnerWorkRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db } = shared;

  app.get("/api/works",async (context) => {
    const auth = context.get("auth");
    if (context.req.header(SESSION_KEY_HEADER)) return context.json(OWNER_ONLY,403);
    if (auth.credentialKind !== "device" && !auth.scopes.has("activities:read")) return context.json({ error: "forbidden" },403);
    const live = context.req.query("state") === "live";
    const limit = Math.min(Math.max(Number(context.req.query("limit") ?? 50) || 50,1),200);
    const rows = await readOwnerWorks(db,auth.principalId,{ live,limit });
    context.header("Cache-Control","no-store");
    return context.json({
      works: await Promise.all(rows.map(async (row) => ({
        ...serializeWork(row,await activeCardFor(db,row.id),{ producerSealed: false }),
        producer: { type: row.producer_type,harness: row.harness },
        sealedText: row.sealed_text ? row.sealed : undefined,
      }))),
    });
  });

  app.get("/api/works/:workId",async (context) => {
    const auth = context.get("auth");
    if (context.req.header(SESSION_KEY_HEADER)) return context.json(OWNER_ONLY,403);
    if (auth.credentialKind !== "device" && !auth.scopes.has("activities:read")) return context.json({ error: "forbidden" },403);
    const id = workInternalId(context.req.param("workId") ?? "");
    const row = id ? await readOwnerWork(db,auth.principalId,id) : undefined;
    if (!row) return context.json({ error: "not_found" },404);
    context.header("Cache-Control","no-store");
    return context.json({
      work: {
        ...serializeWork(row,await activeCardFor(db,row.id),{ producerSealed: false }),
        producer: { type: row.producer_type,harness: row.harness },
        sealedText: row.sealed_text ? row.sealed : undefined,
      },
    });
  });
}
