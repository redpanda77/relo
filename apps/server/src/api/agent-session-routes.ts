import {
  agentSessionListQuerySchema,agentSessionObservedRequestSchema,harnessCredentialCreateRequestSchema,
  type AgentSessionListResponse,type AgentSessionObservedResponse,type HarnessCredentialCreateResponse,
  type HarnessCredentialListResponse,
} from "@relo/notification-contracts";
import type { Hono } from "hono";
import { recordObservedSnapshot } from "../agent-sessions.js";
import { readAgentSessions } from "../agent-session-reads.js";
import { listHarnessCredentials,mintHarnessCredential,revokeHarnessCredential } from "../credentials/harness.js";
import { rotateCredential } from "../credentials/registry.js";
import { sealedEnvelopeSchema } from "../sealed-content.js";
import type { ApiRouteContext } from "./route-context.js";


/**
 * Agent sessions API. Observed snapshots come only from a harness credential (presence:write),
 * which auth.ts allows on that one route; a declared credential is refused there. Reading the list
 * is the owner's: a principal credential with `activities:read`; `?phase=working,waiting` lists
 * only those phases, and the counts cover every phase. Phones read the same list inside the inbox
 * snapshot. Harness credentials are minted and revoked by an owner credential with services:write.
 */
export function registerAgentSessionRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db } = shared;

  app.post("/api/agent-sessions/observed",async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "harness" || !auth.harnessCredentialId) {
      return context.json({ error: "harness_credential_required" },403);
    }
    const body = await context.req.json().catch(() => undefined);
    const input = agentSessionObservedRequestSchema.safeParse(body);
    if (!input.success) return context.json({ error: "invalid_request" },400);
    if (input.data.sealedNames !== undefined) {
      const sealed = sealedEnvelopeSchema.safeParse(input.data.sealedNames);
      if (!sealed.success || sealed.data.kind !== "names") return context.json({ error: "invalid_request" },400);
    }
    // An older or repeated snapshot is not an error: the stored newer one already says more.
    await recordObservedSnapshot(db,auth.principalId,input.data);
    return context.json({ ok: true } satisfies AgentSessionObservedResponse);
  });

  app.get("/api/agent-sessions",async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal" || !auth.credentialId || auth.loginKind === "ci-token") return context.json({ error: "principal_credential_required" },403);
    if (!auth.scopes.has("activities:read")) return context.json({ error: "forbidden" },403);
    const query = agentSessionListQuerySchema.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "invalid_request" },400);
    context.header("Cache-Control","no-store");
    return context.json(await readAgentSessions(db,auth.principalId,{ phases: query.data.phase }) satisfies AgentSessionListResponse);
  });

  app.post("/api/harness-credentials",async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal" || !auth.credentialId || auth.loginKind === "ci-token") return context.json({ error: "principal_credential_required" },403);
    if (!auth.scopes.has("services:write")) return context.json({ error: "forbidden" },403);
    const input = harnessCredentialCreateRequestSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!input.success) return context.json({ error: "invalid_request" },400);
    const minted = await mintHarnessCredential(db,auth.principalId,input.data.name,auth.credentialId);
    if (minted === "limit_reached") return context.json({ error: "credential_limit_reached" },409);
    context.header("Cache-Control","no-store");
    return context.json(minted satisfies HarnessCredentialCreateResponse,201);
  });

  app.get("/api/harness-credentials",async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal" || !auth.credentialId || auth.loginKind === "ci-token") return context.json({ error: "principal_credential_required" },403);
    if (!auth.scopes.has("services:read")) return context.json({ error: "forbidden" },403);
    context.header("Cache-Control","no-store");
    return context.json({ credentials: await listHarnessCredentials(db,auth.principalId) } satisfies HarnessCredentialListResponse);
  });

  app.delete("/api/harness-credentials/:harnessCredentialId",async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal" || !auth.credentialId || auth.loginKind === "ci-token") return context.json({ error: "principal_credential_required" },403);
    if (!auth.scopes.has("services:write")) return context.json({ error: "forbidden" },403);
    if (!await revokeHarnessCredential(db,auth.principalId,context.req.param("harnessCredentialId"))) return context.json({ error: "not_found" },404);
    return context.json({ revoked: true });
  });

  app.post("/api/harness-credentials/:harnessCredentialId/rotate",async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal" || !auth.credentialId || auth.loginKind === "ci-token") return context.json({ error: "principal_credential_required" },403);
    if (!auth.scopes.has("services:write")) return context.json({ error: "forbidden" },403);
    const rotated = await rotateCredential(db,"harness",auth.principalId,context.req.param("harnessCredentialId"));
    if (typeof rotated === "string" || rotated.kind !== "harness") return context.json({ error: "not_found" },404);
    context.header("Cache-Control","no-store");
    return context.json({ id: rotated.id,token: rotated.token } satisfies HarnessCredentialCreateResponse);
  });
}
