import type { Database } from "./db.js";
import { ownerOverviewSql } from "./owner-overview.js";

/**
 * Account-level "require end-to-end encryption" (docs/ENCRYPTION-PROTOCOL.md, E6.1): the setting and its
 * reading. Routes never decide on readable content here: they ask the content policy (content-policy.ts
 * refuseReadable), which reads this for every producer type, webhook services included.
 */
/**
 * The account's choice (true/false) or automatic (null): automatic requires sealing as soon as an
 * active phone of the account has published encryption keys, so encryption is on by default. Relo for
 * Mac (an owner overview device) is never that phone. A local install (Relo for Mac's own server, plan 16)
 * never requires it: nothing leaves the Mac.
 */
export async function endToEndPolicy(db: Pick<Database,"query">,principalId: string): Promise<{ required: boolean; mode: "on" | "off" | "auto" }> {
  const result = await db.query<{ choice: boolean | null; phones_with_keys: boolean }>(
    `SELECT p.require_end_to_end AS choice,EXISTS (
       SELECT 1 FROM device_identity_keys k JOIN devices d ON d.id=k.device_id
       WHERE k.principal_id=p.id AND d.revoked_at IS NULL AND NOT ${ownerOverviewSql("d")}
     ) AS phones_with_keys
     FROM owner_principals p WHERE p.id=$1`,[principalId],
  );
  const row = result.rows[0];
  if (process.env.RELO_LOCAL_MODE === "1") return { required: false,mode: "off" };
  if (row?.choice === true) return { required: true,mode: "on" };
  if (row?.choice === false) return { required: false,mode: "off" };
  return { required: Boolean(row?.phones_with_keys),mode: "auto" };
}

export async function setEndToEndRequired(db: Pick<Database,"query">,principalId: string,required: boolean | null): Promise<void> {
  await db.query("UPDATE owner_principals SET require_end_to_end=$2 WHERE id=$1",[principalId,required]);
}

/** Card fields that carry readable text; numbers, symbols and timings stay allowed. */
export const CARD_TEXT_FIELDS = ["title","status","detail","progressLabel","steps","presentation"] as const;

export function carriesCardText(input: Record<string,unknown>): boolean {
  return CARD_TEXT_FIELDS.some((field) => input[field] !== undefined && input[field] !== null);
}

export const END_TO_END_REQUIRED = {
  error: "end_to_end_required",
  message: "This account requires end-to-end encryption: the CLI seals for a trusted phone (`relo keys status`).",
} as const;
