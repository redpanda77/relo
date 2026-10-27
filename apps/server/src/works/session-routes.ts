import {
  workDeliverRequestSchema,workFinishRequestSchema,workHandoffRequestSchema,workPauseRequestSchema,workResumeRequestSchema,workStartRequestSchema,workUpdateRequestSchema,
} from "@relo/notification-contracts";
import { readSealedOutcome } from "./outcome-notification.js";
import type { Context,Hono } from "hono";
import type { z } from "zod";
import type { ApiRouteContext } from "../api/route-context.js";
import { refuseReadable } from "../content-policy.js";
import { credentialCardActor } from "./card-actor.js";
import { projectWorkCard } from "./card-projection.js";
import { carriesReadable } from "./declared.js";
import {
  deliverSessionWork,finishSessionWork,handoffSessionWork,isRefusal,pauseSessionWork,readSessionState,resumeSessionWork,startSessionWork,updateSessionWork,
  type SessionOwner,type WorkOutcome,
} from "./session-commands.js";
import { activeCardFor,readSessionWork,serializeWork,workInternalId } from "./store.js";

export const SESSION_KEY_HEADER = "relo-session-key";
const HARNESS_HEADER = "relo-harness";
const SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const HARNESS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Every agent-session route answers this body for a missing or foreign id, byte-identical. */
const NOT_FOUND = { error: "not_found",message: "Work not found in this session." } as const;

/**
 * Agent-session works (`/api/session/works…`, STATE-SPEC v2 2.1, 2.8). The producer is the calling
 * session: a Bearer API key with `activities:write` plus `Relo-Session-Key`. Every lookup is scoped
 * in SQL to that session; other sessions' works answer not found. Honest boundary: sessions on one
 * computer share one API key, so this is a context guard, not a defence against a hostile local process.
 */
export function registerSessionWorkRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db,apnsMode,notificationContentCipher } = shared;
  const outcomes = notificationContentCipher ? { apnsMode,contentCipher: notificationContentCipher } : undefined;

  function owner(context: Context): SessionOwner | Response {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:write")) return context.json({ error: "forbidden" },403);
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const sessionKey = context.req.header(SESSION_KEY_HEADER)?.trim();
    if (!sessionKey || !SESSION_KEY_PATTERN.test(sessionKey)) {
      return context.json({ error: "session_key_required",message: "Send Relo-Session-Key with every session route." },400);
    }
    const harness = context.req.header(HARNESS_HEADER)?.trim().toLowerCase();
    return {
      principalId: auth.principalId,credentialId: auth.credentialId,sessionKey,
      harness: harness && HARNESS_PATTERN.test(harness) ? harness : "unknown",
      sourceName: auth.clientName ?? "Relo CLI",
    };
  }

  async function body<T extends z.ZodType>(context: Context,schema: T): Promise<z.infer<T> | Response> {
    let raw: unknown;
    try { raw = await context.req.json(); } catch { raw = {}; }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return context.json({ error: "invalid_request",message: parsed.error.issues.map((issue) => issue.message).join("; ") },400);
    }
    return parsed.data;
  }

  /** Readable text on an account that requires end-to-end encryption is refused before any write. */
  async function readableRefused(context: Context,principalId: string,input: Record<string,unknown>): Promise<Response | null> {
    const readable = carriesReadable(input);
    const refused = readable ? await refuseReadable(db,principalId) : null;
    return refused ? context.json(refused,409) : null;
  }

  function target(context: Context): { workId: string } | null {
    const raw = context.req.param("workId") ?? "";
    if (raw === "current") return { workId: "current" };
    const id = workInternalId(raw);
    return id ? { workId: id } : null;
  }

  async function answer(context: Context,caller: SessionOwner,outcome: WorkOutcome): Promise<Response> {
    if (isRefusal(outcome)) {
      const { status,...rest } = outcome;
      return context.json(rest,status);
    }
    const actor = { kind: "credential" as const,principalId: caller.principalId,credentialId: caller.credentialId,sourceName: caller.sourceName };
    for (const work of outcome.changed) await projectWorkCard(db,apnsMode,credentialCardActor(db,actor),work);
    // The card may have just started (a new work, or a new round after a delivered one) or ended: report it as it stands now.
    const card = outcome.changed.length ? await activeCardFor(db,outcome.changed.at(-1)!.id) : undefined;
    const body = card
      ? { ...outcome.body,work: { ...outcome.body.work,card: serializeWork(outcome.changed.at(-1)!,card).card } }
      : outcome.body;
    return context.json(body,outcome.status);
  }

  const idempotencyKey = (context: Context) => {
    const key = context.req.header("idempotency-key")?.trim();
    return key && key.length <= 200 ? key : undefined;
  };

  app.post("/api/session/works",async (context) => {
    const caller = owner(context); if (caller instanceof Response) return caller;
    const input = await body(context,workStartRequestSchema); if (input instanceof Response) return input;
    const refused = await readableRefused(context,caller.principalId,input); if (refused) return refused;
    return answer(context,caller,await startSessionWork(db,caller,input,idempotencyKey(context)));
  });

  app.get("/api/session/works",async (context) => {
    const caller = owner(context); if (caller instanceof Response) return caller;
    context.header("Cache-Control","no-store");
    return context.json(await readSessionState(db,caller));
  });

  app.get("/api/session/works/:workId",async (context) => {
    const caller = owner(context); if (caller instanceof Response) return caller;
    const selected = target(context);
    if (!selected) return context.json(NOT_FOUND,404);
    context.header("Cache-Control","no-store");
    if (selected.workId === "current") {
      const state = await readSessionState(db,caller);
      return state.open ? context.json({ work: state.open,parked: state.parked }) : context.json(NOT_FOUND,404);
    }
    const work = await readSessionWork(db,caller,selected.workId);
    if (!work) return context.json(NOT_FOUND,404);
    return context.json({ work: serializeWork(work,await activeCardFor(db,work.id)) });
  });

  app.patch("/api/session/works/:workId",async (context) => {
    const caller = owner(context); if (caller instanceof Response) return caller;
    const selected = target(context); if (!selected) return context.json(NOT_FOUND,404);
    const input = await body(context,workUpdateRequestSchema); if (input instanceof Response) return input;
    const refused = await readableRefused(context,caller.principalId,input); if (refused) return refused;
    return answer(context,caller,await updateSessionWork(db,caller,selected,input,idempotencyKey(context)));
  });

  app.post("/api/session/works/:workId/pause",async (context) => {
    const caller = owner(context); if (caller instanceof Response) return caller;
    const selected = target(context); if (!selected) return context.json(NOT_FOUND,404);
    const input = await body(context,workPauseRequestSchema); if (input instanceof Response) return input;
    const refused = await readableRefused(context,caller.principalId,input); if (refused) return refused;
    return answer(context,caller,await pauseSessionWork(db,caller,selected,input,idempotencyKey(context)));
  });

  // `:workId` may be `newest` (the newest paused work of this session).
  app.post("/api/session/works/:workId/resume",async (context) => {
    const caller = owner(context); if (caller instanceof Response) return caller;
    const raw = context.req.param("workId");
    const selected = raw === "newest" ? { workId: "newest" as const } : target(context);
    if (!selected) return context.json(NOT_FOUND,404);
    const input = await body(context,workResumeRequestSchema); if (input instanceof Response) return input;
    return answer(context,caller,await resumeSessionWork(db,caller,selected,idempotencyKey(context)));
  });

  app.post("/api/session/works/:workId/finish",async (context) => {
    const caller = owner(context); if (caller instanceof Response) return caller;
    const selected = target(context); if (!selected) return context.json(NOT_FOUND,404);
    let raw: unknown;
    try { raw = await context.req.json(); } catch { raw = {}; }
    if (raw && typeof raw === "object" && !("outcome" in raw)) {
      return context.json({ error: "outcome_required",message: "Every finish declares an outcome." },422);
    }
    const parsed = workFinishRequestSchema.safeParse(raw);
    if (!parsed.success) return context.json({ error: "invalid_request",message: parsed.error.issues.map((issue) => issue.message).join("; ") },400);
    const badOutcome = readSealedOutcome(parsed.data);
    if ("error" in badOutcome) return context.json({ error: badOutcome.error },422);
    const refused = await readableRefused(context,caller.principalId,parsed.data); if (refused) return refused;
    return answer(context,caller,await finishSessionWork(db,caller,selected,parsed.data,idempotencyKey(context),outcomes));
  });

  app.post("/api/session/works/:workId/deliver",async (context) => {
    const caller = owner(context); if (caller instanceof Response) return caller;
    const selected = target(context); if (!selected) return context.json(NOT_FOUND,404);
    let raw: unknown;
    try { raw = await context.req.json(); } catch { raw = {}; }
    if (raw && typeof raw === "object" && !("outcome" in raw)) {
      return context.json({ error: "outcome_required",message: "Every deliver declares an outcome." },422);
    }
    const parsed = workDeliverRequestSchema.safeParse(raw);
    if (!parsed.success) return context.json({ error: "invalid_request",message: parsed.error.issues.map((issue) => issue.message).join("; ") },400);
    const badOutcome = readSealedOutcome(parsed.data);
    if ("error" in badOutcome) return context.json({ error: badOutcome.error },422);
    const refused = await readableRefused(context,caller.principalId,parsed.data); if (refused) return refused;
    return answer(context,caller,await deliverSessionWork(db,caller,selected,parsed.data,idempotencyKey(context),outcomes));
  });

  // Handoff: the work stays open for a fresh session of this computer; the handle is shown once.
  app.post("/api/session/works/:workId/handoff",async (context) => {
    const caller = owner(context); if (caller instanceof Response) return caller;
    const selected = target(context); if (!selected) return context.json(NOT_FOUND,404);
    const input = await body(context,workHandoffRequestSchema); if (input instanceof Response) return input;
    const refused = await readableRefused(context,caller.principalId,input); if (refused) return refused;
    const outcome = await handoffSessionWork(db,caller,selected,input);
    const answered = await answer(context,caller,outcome);
    if (isRefusal(outcome) || !outcome.handoff) return answered;
    context.header("Cache-Control","no-store");
    return context.json({ ...(await answered.json()),handoff: outcome.handoff },outcome.status);
  });
}
