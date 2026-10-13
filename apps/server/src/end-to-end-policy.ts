import type { Database } from "./db.js";

/**
 * Account-level "require end-to-end encryption" (docs/END-TO-END-ENCRYPTION.md, E6.1). When on,
 * producer credentials (CLI keys) must send sealed text: the server answers 409 end_to_end_required
 * to a readable notice, question or card text. Webhooks hold no keys and are unaffected.
 */
export async function endToEndRequired(db: Pick<Database,"query">,principalId: string): Promise<boolean> {
  return (await endToEndPolicy(db,principalId)).required;
}

/**
 * The account's choice (true/false) or automatic (null): automatic requires sealing as soon as an
 * active phone of the account has published encryption keys, so encryption is on by default.
 */
export async function endToEndPolicy(db: Pick<Database,"query">,principalId: string): Promise<{ required: boolean; mode: "on" | "off" | "auto" }> {
  const result = await db.query<{ choice: boolean | null; phones_with_keys: boolean }>(
    `SELECT p.require_end_to_end AS choice,EXISTS (
       SELECT 1 FROM device_identity_keys k JOIN devices d ON d.id=k.device_id
       WHERE k.principal_id=p.id AND d.revoked_at IS NULL
     ) AS phones_with_keys
     FROM owner_principals p WHERE p.id=$1`,[principalId],
  );
  const row = result.rows[0];
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
  message: "This account requires end-to-end encryption: verify a phone with `relo keys verify` so the CLI can seal this.",
} as const;
