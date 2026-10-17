import type { HarnessCredentialSummary } from "@relo/notification-contracts";
import type { Database } from "../db.js";
import { internalId,publicId } from "../ids.js";
import { generateToken,machineDigest,tokenPrefix } from "./hash.js";

/**
 * Harness credentials (plan HA.1): the hooks' own credential, kind "harness", scope presence:write
 * only. One per computer that turned hooks on. auth.ts refuses it on every route but the observed
 * snapshot route, so it can never write declared state; declared credentials never post observed
 * snapshots. The token is shown once and stored hashed like other machine tokens. Only this module writes
 * the table's token, revocation and last-use columns (plan 10 M1).
 */

/** More than a single owner's computers ever need; a runaway setup loop stops here. */
export const HARNESS_CREDENTIAL_LIMIT = 50;

export type MintedHarnessCredential = { id: string; token: string };

/** Minting links the credential to the computer of the login that makes it (ADR 0011), so the Dashboard lists it there. */
export async function mintHarnessCredential(
  db: Pick<Database,"query">,principalId: string,name: string,createdByKeyId: string,
): Promise<MintedHarnessCredential | "limit_reached"> {
  const token = generateToken();
  // A bound against runaway loops, not an exact quota: concurrent mints at the edge may pass together.
  const result = await db.query<{ id: string }>(
    `INSERT INTO harness_credentials(principal_id,name,token_hash,token_prefix,created_by_key_id,computer_id)
     SELECT $1,$2,$3,$4,$5,(SELECT id FROM computers WHERE login_key_id=$5)
     WHERE (SELECT count(*) FROM harness_credentials WHERE principal_id=$1 AND revoked_at IS NULL)<$6
     RETURNING id`,
    [principalId,name,machineDigest(token),tokenPrefix(token),createdByKeyId,HARNESS_CREDENTIAL_LIMIT],
  );
  if (!result.rows[0]) return "limit_reached";
  return { id: publicId("hck",result.rows[0].id),token };
}

/** Revokes one of the account's harness credentials; idempotent (an already revoked one counts as found). */
export async function revokeHarnessCredential(db: Pick<Database,"query">,principalId: string,id: string): Promise<boolean> {
  const internal = internalId("hck",id);
  if (!internal) return false;
  const result = await db.query(
    "UPDATE harness_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND principal_id=$2 RETURNING id",
    [internal,principalId],
  );
  return Boolean(result.rowCount);
}

export async function listHarnessCredentials(db: Pick<Database,"query">,principalId: string): Promise<HarnessCredentialSummary[]> {
  const result = await db.query<{ id: string; name: string; token_prefix: string; created_at: Date; last_used_at: Date | null }>(
    `SELECT id,name,token_prefix,created_at,last_used_at FROM harness_credentials
     WHERE principal_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT $2`,
    [principalId,HARNESS_CREDENTIAL_LIMIT],
  );
  return result.rows.map((row) => ({
    id: publicId("hck",row.id),
    name: row.name,
    prefix: row.token_prefix,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  }));
}

/** The active harness credential a token belongs to, on an account that still has access. */
export async function findHarnessCredential(db: Pick<Database,"query">,token: string): Promise<{ id: string; principal_id: string } | undefined> {
  const result = await db.query<{ id: string; principal_id: string }>(
    `SELECT h.id,h.principal_id FROM harness_credentials h
     JOIN owner_principals p ON p.id=h.principal_id AND p.disabled_at IS NULL
     WHERE h.token_hash=$1 AND h.revoked_at IS NULL`,
    [machineDigest(token)],
  );
  return result.rows[0];
}

/** A new token for an active harness credential: same row, the old token stops working at once. A revoked one stays revoked. */
export async function rotateHarnessCredential(db: Pick<Database,"query">,principalId: string,id: string): Promise<MintedHarnessCredential | null> {
  const internal = internalId("hck",id);
  if (!internal) return null;
  const token = generateToken();
  const result = await db.query(
    "UPDATE harness_credentials SET token_hash=$3,token_prefix=$4 WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL RETURNING id",
    [internal,principalId,machineDigest(token),tokenPrefix(token)],
  );
  return result.rowCount ? { id,token } : null;
}
