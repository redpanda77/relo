import type { Context, Next } from "hono";
import { isScope, type Scope } from "@relo/notification-contracts";
import { authenticate as findCredential,refusal } from "./credentials/registry.js";
import type { Database } from "./db.js";
import { isOwnerOverview } from "./owner-overview.js";

export type AuthIdentity = {
  principalId: string;
  deviceId?: string;
  deviceCredentialVersion?: number;
  deviceCredentialId?: string;
  credentialId?: string;
  clientName?: string;
  tokenPrefix?: string;
  expiresAt?: Date | null;
  /** Typed by the scope registry (plan 10 M2): a check for a scope that does not exist does not compile. */
  scopes: ReadonlySet<Scope>;
  credentialKind: "principal" | "device" | "harness";
  /** For a principal credential: a browser-approved login or a CI token the owner made (plan 10 A1). */
  loginKind?: "login" | "ci-token";
  /** The harness credential's id (kind "harness" only). */
  harnessCredentialId?: string;
  /** A device that declared `owner_overview`: account-level visibility, never a delivery target (owner-overview.ts). */
  ownerOverview?: boolean;
};

/** The only scope a harness credential holds. */
export const PRESENCE_WRITE_SCOPE: Scope = "presence:write";

/** A stored scope list as the registry knows it; a retired name (devices:pair) grants nothing. */
export function storedScopes(scopes: readonly string[]): ReadonlySet<Scope> {
  return new Set(scopes.filter(isScope));
}

/**
 * The only routes a harness credential may call (method and exact path). Enforced here, once, for
 * every /api route: a hook credential that leaks can post presence and nothing else, and a new
 * route is closed to it unless it is added to this list.
 */
const HARNESS_ROUTES: ReadonlySet<string> = new Set(["POST /api/agent-sessions/observed"]);

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthIdentity;
  }
}

/**
 * Test fixtures insert credentials directly, so the digests stay importable here; production code never
 * calls them outside `credentials/` (credentials-reachability.test.ts).
 */
export { generateToken,machineDigest as hashMachineToken,plainDigest as hashToken } from "./credentials/hash.js";

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

/** The `/api` bearer middleware: which credential the token is (credentials/registry.ts), as an AuthIdentity. */
export function authenticate(db: Database) {
  return async (context: Context, next: Next) => {
    const token = bearerToken(context.req.header("authorization"));
    if (!token) return context.json({ error: "unauthorized" }, 401);
    const found = await findCredential(db,token);
    if (!found) return context.json(await refusal(db,token),401);
    if (found.kind === "login") {
      const login = found.login;
      context.set("auth", {
        principalId: login.principal_id,
        credentialId: login.id,
        clientName: login.display_name ?? login.label,
        tokenPrefix: login.token_prefix,
        expiresAt: login.expires_at,
        scopes: storedScopes(login.scopes),
        credentialKind: "principal",
        loginKind: login.kind,
      });
    } else if (found.kind === "harness") {
      if (!HARNESS_ROUTES.has(`${context.req.method} ${new URL(context.req.url).pathname}`)) {
        return context.json({ error: "harness_credential_not_allowed" },403);
      }
      context.set("auth", {
        principalId: found.harness.principal_id,
        harnessCredentialId: found.harness.id,
        scopes: new Set([PRESENCE_WRITE_SCOPE]),
        credentialKind: "harness",
      });
    } else {
      const device = found.device;
      context.set("auth", {
        principalId: device.principal_id,
        deviceCredentialId: device.credential_id,
        expiresAt: device.expires_at,
        deviceId: device.device_id,
        deviceCredentialVersion: device.credential_version,
        scopes: storedScopes(device.scopes),
        credentialKind: "device",
        ...(isOwnerOverview(device.capabilities) ? { ownerOverview: true } : {}),
      });
    }
    await next();
  };
}

export function requireScope(scope: Scope) {
  return async (context: Context, next: Next) => {
    if (!context.get("auth").scopes.has(scope)) return context.json({ error: "forbidden" }, 403);
    await next();
  };
}
