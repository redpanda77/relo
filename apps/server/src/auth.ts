import { createHash, randomBytes } from "node:crypto";
import type { Context, Next } from "hono";
import type { Database } from "./db.js";

export type AuthIdentity = {
  principalId: string;
  deviceId?: string;
  deviceCredentialVersion?: number;
  deviceCredentialId?: string;
  credentialId?: string;
  clientName?: string;
  tokenPrefix?: string;
  expiresAt?: Date | null;
  scopes: Set<string>;
  credentialKind: "principal" | "device" | "harness";
  /** The harness credential's id (kind "harness" only). */
  harnessCredentialId?: string;
};

/** The only scope a harness credential holds. */
export const PRESENCE_WRITE_SCOPE = "presence:write";

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

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashMachineToken(token: string): string {
  return hashToken(`relo:access-token:v1\n${token}`);
}

export function generateToken(): string {
  return `relo_${randomBytes(32).toString("base64url")}`;
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function authenticate(db: Database) {
  return async (context: Context, next: Next) => {
    const token = bearerToken(context.req.header("authorization"));
    if (!token) return context.json({ error: "unauthorized" }, 401);
    const digests = [hashToken(token), hashMachineToken(token)];

    const principal = await db.query<{
      id: string;
      principal_id: string;
      label: string;
      token_prefix: string;
      expires_at: Date | null;
      scopes: string[];
    }>(
      `SELECT k.id,k.principal_id,k.label,k.token_prefix,k.expires_at,k.scopes
       FROM principal_api_keys k
       JOIN owner_principals p ON p.id = k.principal_id
       WHERE k.token_hash=ANY($1::text[]) AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > now()) AND p.disabled_at IS NULL`,
      [digests],
    );
    if (principal.rowCount) {
      context.set("auth", {
        principalId: principal.rows[0]!.principal_id,
        credentialId: principal.rows[0]!.id,
        clientName: principal.rows[0]!.label,
        tokenPrefix: principal.rows[0]!.token_prefix,
        expiresAt: principal.rows[0]!.expires_at,
        scopes: new Set(principal.rows[0]!.scopes),
        credentialKind: "principal",
      });
      await db.query("UPDATE principal_api_keys SET last_used_at=now() WHERE id=$1", [principal.rows[0]!.id]);
      await next();
      return;
    }

    const device = await db.query<{
      credential_id: string;
      expires_at: Date | null;
      principal_id: string;
      device_id: string;
      credential_version: number;
      scopes: string[];
    }>(
      `SELECT c.id AS credential_id,c.expires_at,d.principal_id, d.id AS device_id, d.credential_version, c.scopes
       FROM device_credentials c
       JOIN devices d ON d.id = c.device_id
       JOIN owner_principals p ON p.id = d.principal_id
       WHERE c.token_hash = $1 AND c.revoked_at IS NULL
         AND (c.expires_at IS NULL OR c.expires_at > now())
         AND d.revoked_at IS NULL AND p.disabled_at IS NULL`,
      [digests[0]],
    );
    if (!device.rowCount) {
      const harness = await db.query<{ id: string; principal_id: string }>(
        `UPDATE harness_credentials h SET last_used_at=now()
         FROM owner_principals p
         WHERE h.token_hash=$1 AND h.revoked_at IS NULL AND p.id=h.principal_id AND p.disabled_at IS NULL
         RETURNING h.id,h.principal_id`,
        [digests[1]],
      );
      if (!harness.rowCount) return context.json(await refusal(db,digests),401);
      if (!HARNESS_ROUTES.has(`${context.req.method} ${new URL(context.req.url).pathname}`)) {
        return context.json({ error: "harness_credential_not_allowed" },403);
      }
      context.set("auth", {
        principalId: harness.rows[0]!.principal_id,
        harnessCredentialId: harness.rows[0]!.id,
        scopes: new Set([PRESENCE_WRITE_SCOPE]),
        credentialKind: "harness",
      });
      await next();
      return;
    }
    context.set("auth", {
      principalId: device.rows[0]!.principal_id,
      deviceCredentialId: device.rows[0]!.credential_id,
      expiresAt: device.rows[0]!.expires_at,
      deviceId: device.rows[0]!.device_id,
      deviceCredentialVersion: device.rows[0]!.credential_version,
      scopes: new Set(device.rows[0]!.scopes),
      credentialKind: "device",
    });
    await next();
  };
}

/**
 * Why a credential that was once valid no longer works, so an app knows whether signing in again
 * can help. Only the token's holder learns this; an unknown token stays plain "unauthorized".
 */
async function refusal(db: Database, digests: string[]): Promise<{ error: string; message?: string }> {
  const found = await db.query<{ disabled: boolean; revoked: boolean; expired: boolean }>(
    `SELECT p.disabled_at IS NOT NULL AS disabled,k.revoked_at IS NOT NULL AS revoked,
       (k.expires_at IS NOT NULL AND k.expires_at<=now()) AS expired
     FROM principal_api_keys k JOIN owner_principals p ON p.id=k.principal_id WHERE k.token_hash=ANY($1::text[])
     UNION ALL
     SELECT p.disabled_at IS NOT NULL,(c.revoked_at IS NOT NULL OR d.revoked_at IS NOT NULL),
       (c.expires_at IS NOT NULL AND c.expires_at<=now())
     FROM device_credentials c JOIN devices d ON d.id=c.device_id JOIN owner_principals p ON p.id=d.principal_id
     WHERE c.token_hash=$2
     UNION ALL
     SELECT p.disabled_at IS NOT NULL,h.revoked_at IS NOT NULL,false
     FROM harness_credentials h JOIN owner_principals p ON p.id=h.principal_id WHERE h.token_hash=$3
     LIMIT 1`,
    [digests,digests[0],digests[1]],
  );
  const row = found.rows[0];
  if (!row) return { error: "unauthorized" };
  if (row.disabled) return { error: "account_disabled",message: "The server admin turned off this account's access." };
  if (row.revoked) return { error: "credential_revoked",message: "This login was revoked." };
  if (row.expired) return { error: "login_expired",message: "This login expired." };
  return { error: "unauthorized" };
}

export function requireScope(scope: string) {
  return async (context: Context, next: Next) => {
    if (!context.get("auth").scopes.has(scope)) return context.json({ error: "forbidden" }, 403);
    await next();
  };
}
