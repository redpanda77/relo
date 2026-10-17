import { workFinishRequestSchema } from "@relo/notification-contracts";
import type { Hono } from "hono";
import type { ApiRouteContext } from "../api/route-context.js";
import { refuseReadable } from "../content-policy.js";
import { credentialCardActor } from "./card-actor.js";
import { projectWorkCard } from "./card-projection.js";
import { finishAccountWork } from "./session-commands.js";
import { endWorkForOwner } from "./end-route.js";
import { SESSION_KEY_HEADER } from "./session-routes.js";
import { activeCardFor,readOwnerWork,readOwnerWorks,serializeWork,workInternalId } from "./store.js";

const OWNER_ONLY = {
  error: "owner_only",
  message: "This lists every session; it is for the owner.",
  next: "relo state",
} as const;

/**
 * The owner's surface for works (phones, linked browsers, Dashboard, owner API keys, and `relo admin`, which an
 * agent runs only when the owner asks it for help). Cross-session reads and the admin finish are the owner's:
 * a caller that names an agent session is refused, so a session's normal commands never reach other
 * sessions. The producer's own sealed copy rides along for API keys (only the computer that sealed it can
 * open it), never for phones.
 */
export function registerOwnerWorkRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db,apnsMode } = shared;

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
        ...serializeWork(row,await activeCardFor(db,row.id),{ producerSealed: auth.credentialKind !== "device" }),
        updatedAt: row.updated_at.toISOString(),
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
        ...serializeWork(row,await activeCardFor(db,row.id),{ producerSealed: auth.credentialKind !== "device" }),
        updatedAt: row.updated_at.toISOString(),
        producer: { type: row.producer_type,harness: row.harness },
        sealedText: row.sealed_text ? row.sealed : undefined,
      },
    });
  });

  // Admin finish: ends a hanging work (paused, or quiet for 20 minutes) whichever session or script started it.
  app.post("/api/works/:workId/finish",async (context) => {
    const auth = context.get("auth");
    if (context.req.header(SESSION_KEY_HEADER)) return context.json(OWNER_ONLY,403);
    if (!auth.scopes.has("activities:write") || !auth.credentialId) return context.json({ error: "forbidden" },403);
    const id = workInternalId(context.req.param("workId") ?? "");
    if (!id) return context.json({ error: "not_found",message: "Work not found." },404);
    let raw: unknown;
    try { raw = await context.req.json(); } catch { raw = {}; }
    const parsed = workFinishRequestSchema.safeParse(raw);
    if (!parsed.success) return context.json({ error: "invalid_request",message: parsed.error.issues.map((issue) => issue.message).join("; ") },400);
    if (typeof parsed.data.outcome === "object" && "readable" in parsed.data.outcome) {
      const refused = await refuseReadable(db,auth.principalId);
      if (refused) return context.json(refused,409);
    }
    const outcome = await finishAccountWork(db,auth.principalId,id,parsed.data);
    if ("error" in outcome) {
      const { status,...rest } = outcome;
      return context.json(rest,status);
    }
    await projectWorkCard(db,apnsMode,credentialCardActor(db,{ kind: "credential",principalId: auth.principalId,credentialId: auth.credentialId,
      sourceName: auth.clientName ?? "Relo CLI" }),outcome.work);
    return context.json({ work: serializeWork(outcome.work,await activeCardFor(db,outcome.work.id),{ producerSealed: false }) });
  });

  // The owner's End from the phone (the Dashboard has its twin under /api/dashboard): a work that is quiet, left open,
  // delivered or paused moves to History; a moving one answers `work_running`. The phone credential only.
  app.post("/api/works/:workId/end",async (context) => {
    const auth = context.get("auth");
    if (context.req.header(SESSION_KEY_HEADER)) return context.json(OWNER_ONLY,403);
    if (auth.credentialKind !== "device" || !auth.scopes.has("interactions:respond")) return context.json({ error: "forbidden" },403);
    let raw: unknown;
    try { raw = await context.req.json(); } catch { raw = {}; }
    const result = await endWorkForOwner(db,apnsMode,auth.principalId,context.req.param("workId") ?? "",raw);
    return context.json(result.body,result.status);
  });
}
