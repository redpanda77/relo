import type { Hono } from "hono";
import { z } from "zod";
import { FACTS,loginScopeSchema,LOGIN_SCOPES } from "@relo/notification-contracts";
import { requireScope } from "../auth.js";
import { kindFacts } from "../credentials/kinds.js";
import { listCiTokens,mintCiToken,revokeCiToken } from "../credentials/login.js";
import { rotateCredential } from "../credentials/registry.js";
import { internalId,publicId } from "../ids.js";
import type { ApiRouteContext } from "./route-context.js";

/** A CI token as the owner sees it: never its secret after creation. */
export function ciTokenResource(row: any) {
  return {
    id: publicId("key",row.id),
    name: row.label,
    prefix: row.token_prefix,
    scopes: row.scopes,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  };
}

export const ciTokenCreateSchema = z.object({
  /** How the token shows in lists (the pipeline or container that holds it). */
  name: z.string().trim().min(1).max(80).describe("How the token shows in lists, such as the pipeline that holds it."),
  /** What it may do; every scope its maker holds when omitted. */
  scopes: z.array(loginScopeSchema).min(1).max(LOGIN_SCOPES.length).transform((scopes) => [...new Set(scopes)].sort()).optional()
    .describe("What the token may do; every scope its maker holds when omitted. It cannot hold a scope its maker lacks."),
  expiresInDays: z.number().int().min(1).max(FACTS.credentials.ciTokenMaxDays).default(FACTS.credentials.ciTokenDefaultDays)
    .describe("How many days the token works before it expires."),
}).strict();

export const CI_TOKEN_REFUSALS = {
  limit_reached: [409,`An account holds at most ${FACTS.credentials.ciTokenMaxActive} CI tokens; revoke one first.`],
  name_taken: [409,"A login or CI token already has this name."],
  scope_not_held: [403,"A CI token can hold only scopes its maker holds."],
  expiry_too_long: [400,`A CI token lives at most ${FACTS.credentials.ciTokenMaxDays} days.`],
  ci_token_cannot_mint: [403,"A CI token cannot make another CI token."],
} as const;

/**
 * CI tokens (plan 10 A1): `relo auth token create|list|revoke` for a signed-in owner's login with services:write.
 * Minting, listing and revoking are credentials/login.ts; this module is the routes.
 */
export function registerCredentialRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db } = shared;
  app.post("/api/credentials",requireScope("services:write"),async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal" || !auth.credentialId) return context.json({ error: "cli_credential_required" },403);
    const input = ciTokenCreateSchema.parse(await context.req.json());
    const minted = await mintCiToken(db,{
      principalId: auth.principalId,name: input.name,scopes: input.scopes ?? [...auth.scopes].filter((scope) => (kindFacts("ci-token").scopes as readonly string[]).includes(scope)).sort(),
      expiresInDays: input.expiresInDays,
      maker: { credentialId: auth.credentialId,kind: auth.loginKind ?? "login",scopes: auth.scopes },
    });
    if (typeof minted === "string") {
      const [status,message] = CI_TOKEN_REFUSALS[minted];
      return context.json({ error: minted,message },status);
    }
    return context.json({ token: minted.token,credential: ciTokenResource(minted.row) },201);
  });

  app.get("/api/credentials",requireScope("services:read"),async (context) => {
    const auth = context.get("auth");
    return context.json({ tokens: (await listCiTokens(db,auth.principalId)).map(ciTokenResource) });
  });

  app.delete("/api/credentials/:credentialId",requireScope("services:write"),async (context) => {
    const auth = context.get("auth");
    const id = internalId("key",context.req.param("credentialId") ?? "");
    if (!id) return context.json({ error: "not_found" },404);
    return await revokeCiToken(db,auth.principalId,id) ? context.json({ revoked: true }) : context.json({ error: "not_found" },404);
  });

  /**
   * Rotate a CI token: a new secret for the same token (id, name, scopes, expiry); the old one stops working at
   * once. A CI token may rotate only itself (a pipeline refreshing its own secret), never another CI token; the
   * owner's login rotates any of the account's. A revoked or expired token cannot be rotated.
   */
  app.post("/api/credentials/:credentialId/rotate",requireScope("services:write"),async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal" || !auth.credentialId) return context.json({ error: "cli_credential_required" },403);
    const id = internalId("key",context.req.param("credentialId") ?? "");
    if (!id) return context.json({ error: "not_found" },404);
    if (auth.loginKind === "ci-token" && auth.credentialId !== id) return context.json({ error: "ci_token_cannot_rotate_another" },403);
    const rotated = await rotateCredential(db,"ci-token",auth.principalId,id);
    if (typeof rotated === "string") return context.json({ error: "not_found" },404);
    if (rotated.kind !== "ci-token") return context.json({ error: "not_found" },404);
    context.header("Cache-Control","no-store");
    return context.json({ token: rotated.token,credential: ciTokenResource(rotated.row) });
  });
}
