import type { Database } from "./db.js";

/**
 * Account-level "require end-to-end encryption" (docs/END-TO-END-ENCRYPTION.md, E6.1). When on,
 * producer credentials (CLI keys) must send sealed text: the server answers 409 end_to_end_required
 * to a readable notice, question or card text. Webhooks hold no keys and are unaffected.
 */
export async function endToEndRequired(db: Pick<Database,"query">,principalId: string): Promise<boolean> {
  const result = await db.query<{ require_end_to_end: boolean }>(
    "SELECT require_end_to_end FROM owner_principals WHERE id=$1",[principalId],
  );
  return Boolean(result.rows[0]?.require_end_to_end);
}

export async function setEndToEndRequired(db: Pick<Database,"query">,principalId: string,required: boolean): Promise<void> {
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
