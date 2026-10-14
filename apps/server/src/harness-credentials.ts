import type { HarnessCredentialSummary } from "@relo/notification-contracts";
import type { Database } from "./db.js";
import { generateToken,hashMachineToken } from "./auth.js";
import { internalId,publicId } from "./ids.js";

/**
 * Harness credentials (plan HA.1): the hooks' own credential, kind "harness", scope presence:write
 * only. One per computer that turned hooks on. auth.ts refuses it on every route but the observed
 * snapshot route, so it can never write declared state; declared credentials never post observed
 * snapshots. The token is shown once and stored hashed like other machine tokens.
 */

/** More than a single owner's computers ever need; a runaway setup loop stops here. */
export const HARNESS_CREDENTIAL_LIMIT = 50;

export type MintedHarnessCredential = { id: string; token: string };

export async function mintHarnessCredential(
  db: Pick<Database,"query">,principalId: string,name: string,createdByKeyId: string,
): Promise<MintedHarnessCredential | "limit_reached"> {
  const token = generateToken();
  // A bound against runaway loops, not an exact quota: concurrent mints at the edge may pass together.
  const result = await db.query<{ id: string }>(
    `INSERT INTO harness_credentials(principal_id,name,token_hash,token_prefix,created_by_key_id)
     SELECT $1,$2,$3,$4,$5
     WHERE (SELECT count(*) FROM harness_credentials WHERE principal_id=$1 AND revoked_at IS NULL)<$6
     RETURNING id`,
    [principalId,name,hashMachineToken(token),token.slice(0,15),createdByKeyId,HARNESS_CREDENTIAL_LIMIT],
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
