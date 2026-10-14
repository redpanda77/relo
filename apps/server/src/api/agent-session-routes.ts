import {
  agentSessionEventRequestSchema,agentSessionListQuerySchema,type AgentSessionEventResponse,type AgentSessionListResponse,
} from "@relo/notification-contracts";
import type { Context,Hono } from "hono";
import { readAgentSessions,recordAgentSessionEvent } from "../agent-sessions.js";
import { consumeRateLimit } from "../rate-limit.js";
import { sealedEnvelopeSchema } from "../sealed-content.js";
import type { ApiRouteContext } from "./route-context.js";

/** Per minute; the CLI coalesces tool events to one a minute, so real traffic is far below this. */
const CLIENT_EVENTS_PER_MINUTE = 120;
const ACCOUNT_EVENTS_PER_MINUTE = 600;
const RATE_FAMILY = "agent-session-events";

/**
 * Agent sessions API. Writing needs `sessions:write`; keys issued before the scope existed are
 * accepted through `activities:write`, which already controls the session's card. Reading needs
 * `activities:read` or `sessions:write`; `?phase=working,waiting` lists only those phases, and the
 * counts cover every phase. Phones read the same list inside the inbox snapshot.
 */
export function registerAgentSessionRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db } = shared;

  app.post("/api/agent-sessions/events",async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("sessions:write") && !auth.scopes.has("activities:write")) {
      return context.json({ error: "forbidden" },403);
    }
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const limited = await rateLimited(context,auth.principalId,auth.credentialId);
    if (limited) return limited;
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request" },400); }
    const input = agentSessionEventRequestSchema.parse(body);
    if (input.sealedNames !== undefined) {
      const sealed = sealedEnvelopeSchema.safeParse(input.sealedNames);
      if (!sealed.success || sealed.data.kind !== "names") return context.json({ error: "invalid_request" },400);
    }
    const state = await recordAgentSessionEvent(db,auth.principalId,input);
    return context.json({ ok: true,state } satisfies AgentSessionEventResponse);
  });

  app.get("/api/agent-sessions",async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:read") && !auth.scopes.has("sessions:write")) {
      return context.json({ error: "forbidden" },403);
    }
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    const query = agentSessionListQuerySchema.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "invalid_request" },400);
    context.header("Cache-Control","no-store");
    return context.json(await readAgentSessions(db,auth.principalId,{ phases: query.data.phase }) satisfies AgentSessionListResponse);
  });

  async function rateLimited(context: Context,principalId: string,credentialId: string) {
    for (const [scope,id,limit] of [
      ["account",principalId,ACCOUNT_EVENTS_PER_MINUTE],
      ["client",credentialId,CLIENT_EVENTS_PER_MINUTE],
    ] as const) {
      const consumed = await consumeRateLimit(db,{ scope,id,family: RATE_FAMILY,limit });
      if (!consumed.allowed) {
        context.header("retry-after",String(consumed.retryAfterSeconds));
        return context.json({ error: "rate_limited",scope,retryAfterSeconds: consumed.retryAfterSeconds },429);
      }
    }
    return null;
  }
}
