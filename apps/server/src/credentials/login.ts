import { FACTS } from "@relo/notification-contracts";
import type { Database } from "../db.js";
import { generateToken,loginDigests,machineDigest,plainDigest,tokenPrefix } from "./hash.js";
import { ensureComputer } from "../computers/store.js";
import { kindFacts } from "./kinds.js";

type Queryable = Pick<Database,"query">;

/**
 * Logins (kind "login", `principal_api_keys`): a CLI or app signed in through device authorization, the
 * bootstrap owner key, or a hash registered offline. Only this module writes their token, revocation and
 * last-use columns (plan 10 M1).
 */

/** Active logins an account may hold; a runaway sign-in loop stops here. */
export const LOGIN_LIMIT = 50;

export type LoginKind = "login" | "ci-token";
export type LoginRow = {
  id: string; principal_id: string; label: string; token_prefix: string; expires_at: Date | null; scopes: string[]; kind: LoginKind;
  /** The owner's name for this login's computer (ADR 0011); null when none was set or for a CI token. */
  display_name: string | null;
};

/** The active login a token belongs to, on an account that still has access. */
export async function findLogin(db: Queryable,token: string): Promise<LoginRow | undefined> {
  const result = await db.query<LoginRow>(
    `SELECT k.id,k.principal_id,k.label,k.token_prefix,k.expires_at,k.scopes,k.kind,c.display_name
     FROM principal_api_keys k
     JOIN owner_principals p ON p.id = k.principal_id
     LEFT JOIN computers c ON c.login_key_id = k.id
     WHERE k.token_hash=ANY($1::text[]) AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > now()) AND p.disabled_at IS NULL`,
    [loginDigests(token)],
  );
  return result.rows[0];
}

/**
 * Issues the login a device authorization approved. A login with the same label is replaced (signing in
 * again on the same computer); a new label counts against LOGIN_LIMIT. Runs inside the caller's transaction.
 */
export async function issueLogin(client: Queryable,input: {
  principalId: string; label: string; scopes: string[]; expiresAt: Date | null;
}): Promise<{ token: string; row: any } | "limit_reached" | "name_taken"> {
  const existing = await client.query("SELECT id FROM principal_api_keys WHERE principal_id=$1 AND label=$2 FOR UPDATE",[input.principalId,input.label]);
  if (!existing.rowCount) {
    const count = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM principal_api_keys WHERE principal_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
      [input.principalId],
    );
    if (count.rows[0]!.count >= LOGIN_LIMIT) return "limit_reached";
  }
  const token = generateToken();
  const credential = await client.query<any>(
    `INSERT INTO principal_api_keys(principal_id,label,token_hash,token_prefix,scopes,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (principal_id,label) DO UPDATE SET
       token_hash=EXCLUDED.token_hash,token_prefix=EXCLUDED.token_prefix,
       scopes=EXCLUDED.scopes,expires_at=EXCLUDED.expires_at,
       created_at=now(),last_used_at=NULL,revoked_at=NULL,kind='login',created_by_key_id=NULL
     WHERE principal_api_keys.kind='login' OR principal_api_keys.revoked_at IS NOT NULL
       OR principal_api_keys.expires_at<=now()
     RETURNING *`,
    [input.principalId,input.label,machineDigest(token),tokenPrefix(token),input.scopes,input.expiresAt],
  );
  // A sign-in never replaces a live CI token that carries the same name; a revoked or expired one frees its name.
  if (!credential.rows[0]) return "name_taken";
  // The computer is one-to-one with this row, which a sign-in on the same machine upserts (ADR 0011).
  await ensureComputer(client,credential.rows[0].id);
  return { token,row: credential.rows[0] };
}

/** The bootstrap owner key from the environment: one active key labelled bootstrap-owner, the given token's. */
export async function setBootstrapLogin(client: Queryable,principalId: string,token: string): Promise<void> {
  const digest = plainDigest(token);
  await client.query(
    `UPDATE principal_api_keys SET revoked_at=now()
     WHERE principal_id=$1 AND label='bootstrap-owner' AND token_hash<>$2 AND revoked_at IS NULL`,
    [principalId,digest],
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO principal_api_keys(principal_id, label, token_hash)
     VALUES ($1, 'bootstrap-owner', $2)
     ON CONFLICT (token_hash) DO UPDATE SET revoked_at=NULL
     RETURNING id`,
    [principalId,digest],
  );
  await ensureComputer(client,inserted.rows[0]?.id);
}

/**
 * Registers a login from a digest computed elsewhere (the operator's offline recovery path: the server never
 * sees the token). Returns the login's id, or undefined when the handle has no active owner.
 */
export async function registerLoginDigest(db: Queryable,input: {
  handle: string; label: string; tokenHash: string; scopes: string[];
}): Promise<string | undefined> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes)
     SELECT p.id,$2,$3,$4 FROM owner_principals p WHERE p.handle=$1 AND p.disabled_at IS NULL
     ON CONFLICT (principal_id,label) DO UPDATE SET
       token_hash=EXCLUDED.token_hash,scopes=EXCLUDED.scopes,revoked_at=NULL
     RETURNING id`,
    [input.handle,input.label,input.tokenHash,input.scopes],
  );
  await ensureComputer(db,result.rows[0]?.id);
  return result.rows[0]?.id;
}

/** The owner revokes one of the account's logins; idempotent. */
export async function revokeLogin(db: Queryable,principalId: string,id: string): Promise<boolean> {
  const result = await db.query("UPDATE principal_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND principal_id=$2 RETURNING id",[id,principalId]);
  return Boolean(result.rowCount);
}

/** A login revokes itself by its own token (signing out); an expired or unknown token finds nothing. */
export async function revokeLoginByToken(db: Queryable,token: string): Promise<string | undefined> {
  const result = await db.query<{ id: string }>(
    `UPDATE principal_api_keys k SET revoked_at=COALESCE(k.revoked_at,now())
     FROM owner_principals p
     WHERE k.principal_id=p.id AND k.token_hash=ANY($1::text[])
       AND (k.expires_at IS NULL OR k.expires_at>now()) AND p.disabled_at IS NULL
     RETURNING k.id`,
    [loginDigests(token)],
  );
  return result.rows[0]?.id;
}

/** Active CI tokens an account may hold. */
export const CI_TOKEN_LIMIT = FACTS.credentials.ciTokenMaxActive;

export type CiTokenRefusal = "limit_reached" | "name_taken" | "scope_not_held" | "expiry_too_long" | "ci_token_cannot_mint";

/**
 * A CI token (plan 10 A1): a login the owner makes for a pipeline. It holds at most its maker's scopes, always
 * expires (within the facts' maximum), never replaces another login of the same name, and cannot itself make one.
 */
export async function mintCiToken(db: Queryable,input: {
  principalId: string; name: string; scopes: string[]; expiresInDays: number;
  maker: { credentialId: string | null; kind: LoginKind | "owner"; scopes: ReadonlySet<string> | "all" };
}): Promise<{ token: string; row: any } | CiTokenRefusal> {
  if (input.maker.kind === "ci-token") return "ci_token_cannot_mint";
  if (input.expiresInDays > kindFacts("ci-token").lifetime!.maxDays) return "expiry_too_long";
  const held = input.maker.scopes;
  if (held !== "all" && input.scopes.some((scope) => !held.has(scope))) return "scope_not_held";
  const count = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM principal_api_keys WHERE principal_id=$1 AND kind='ci-token' AND revoked_at IS NULL AND expires_at>now()",
    [input.principalId],
  );
  if (count.rows[0]!.count >= CI_TOKEN_LIMIT) return "limit_reached";
  const token = generateToken();
  const inserted = await db.query<any>(
    `INSERT INTO principal_api_keys(principal_id,label,token_hash,token_prefix,scopes,expires_at,kind,created_by_key_id)
     VALUES ($1,$2,$3,$4,$5,now()+make_interval(days=>$6),'ci-token',$7)
     ON CONFLICT (principal_id,label) DO NOTHING RETURNING *`,
    [input.principalId,input.name,machineDigest(token),tokenPrefix(token),input.scopes,input.expiresInDays,input.maker.credentialId],
  );
  return inserted.rows[0] ? { token,row: inserted.rows[0] } : "name_taken";
}

/** The account's CI tokens that still work, newest first. */
export async function listCiTokens(db: Queryable,principalId: string): Promise<any[]> {
  return (await db.query(
    `SELECT * FROM principal_api_keys WHERE principal_id=$1 AND kind='ci-token' AND revoked_at IS NULL AND expires_at>now()
     ORDER BY created_at DESC LIMIT $2`,[principalId,CI_TOKEN_LIMIT])).rows;
}

/** Revokes one CI token of the account; idempotent. */
export async function revokeCiToken(db: Queryable,principalId: string,id: string): Promise<boolean> {
  const result = await db.query("UPDATE principal_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND principal_id=$2 AND kind='ci-token' RETURNING id",[id,principalId]);
  return Boolean(result.rowCount);
}

/**
 * A new token for an active CI token: same row (id, name, scopes, expiry), the old token stops working at once.
 * A revoked or expired CI token, a login and another account's token are not found.
 */
export async function rotateCiToken(db: Queryable,principalId: string,id: string): Promise<{ token: string; row: any } | null> {
  const token = generateToken();
  const result = await db.query<any>(
    `UPDATE principal_api_keys SET token_hash=$3,token_prefix=$4
     WHERE id=$1 AND principal_id=$2 AND kind='ci-token' AND revoked_at IS NULL AND expires_at>now() RETURNING *`,
    [id,principalId,machineDigest(token),tokenPrefix(token)],
  );
  return result.rows[0] ? { token,row: result.rows[0] } : null;
}
