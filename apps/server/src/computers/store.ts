import { createHash } from "node:crypto";
import { computerIconSchema,type ComputerIcon,type ComputerIconSource,type ComputerRename,type ComputerReport } from "@relo/notification-contracts";
import type { Database } from "../db.js";

type Queryable = Pick<Database,"query">;
/** The pool, or a transaction a caller owns. */
type Runner = { query: (text: string,values?: unknown[]) => Promise<{ rowCount: number | null }> };

/**
 * Computers (ADR 0011): one row per login credential, holding what the owner chose for it (display name,
 * icon) and what the machine reported. This module is the only place that reads or writes `computers`.
 * The login's label stays the unique upsert key and a rename never touches it.
 */

/**
 * Makes sure the login has its computer; a re-login finds the existing one. CI tokens never get one: the
 * statement selects only `kind='login'` rows, and an unknown id inserts nothing.
 */
export async function ensureComputer(db: Queryable,loginKeyId: string | undefined): Promise<void> {
  if (!loginKeyId) return;
  await db.query(
    `INSERT INTO computers(principal_id,login_key_id)
     SELECT principal_id,id FROM principal_api_keys WHERE id=$1 AND kind='login'
     ON CONFLICT (login_key_id) DO NOTHING`,
    [loginKeyId],
  );
}

export type ComputerRow = {
  id: string; principal_id: string; login_key_id: string;
  display_name: string | null; icon: ComputerIcon | null;
  report: unknown; reported_at: Date | null;
  created_at: Date; updated_at: Date;
  /** The login's own columns, for the Connections row. */
  label: string; token_prefix: string; scopes: string[];
  login_created_at: Date; expires_at: Date | null; last_used_at: Date | null;
  live_activity_policy: unknown; max_active_cards: number | null;
};

/** What a computer is called: its display name, else its login's label (which a rename never edits). */
export function computerDisplayName(row: Pick<ComputerRow,"display_name" | "label">): string {
  return row.display_name ?? row.label;
}

/**
 * The icon shown for a computer: the owner's choice, else the CLI's `machineKind` hint from its report,
 * else a laptop (ADR 0011).
 */
export function effectiveIcon(row: Pick<ComputerRow,"icon" | "report">): { icon: ComputerIcon; source: ComputerIconSource } {
  return iconFromColumns(row.icon,(row.report as { machineKind?: unknown } | null)?.machineKind);
}

/**
 * The same rule for a statement that selects only the two columns it needs: `icon` and
 * `report->>'machineKind'`, so a list of rows never pulls whole reports. The one place the rule lives.
 */
export function iconFromColumns(icon: ComputerIcon | null | undefined,machineKind: unknown): { icon: ComputerIcon; source: ComputerIconSource } {
  if (icon) return { icon,source: "owner" };
  const hint = computerIconSchema.safeParse(machineKind);
  return hint.success ? { icon: hint.data,source: "detected" } : { icon: "laptop",source: "default" };
}

/** SQL for a computer's two icon inputs (the `computers` table under `alias`), to select next to `iconFromColumns`. */
export const computerIconColumns = (alias: string) =>
  `${alias}.icon AS computer_icon,${alias}.report->>'machineKind' AS computer_kind`;

/**
 * The icon a credential's cards show: its computer's effective icon. A credential with no computer (a CI
 * token) has none, and its cards keep the generic project icon.
 */
export async function effectiveComputerIcon(
  db: { query: (text: string,values?: unknown[]) => Promise<{ rows: any[] }> },credentialId: string,
): Promise<ComputerIcon | undefined> {
  const row = (await db.query(
    "SELECT icon,report FROM computers WHERE login_key_id=$1",[credentialId],
  )).rows[0] as Pick<ComputerRow,"icon" | "report"> | undefined;
  return row ? effectiveIcon(row).icon : undefined;
}

const SELECT_COMPUTER =
  `SELECT c.id,c.principal_id,c.login_key_id,c.display_name,c.icon,c.report,c.reported_at,c.created_at,c.updated_at,
     k.label,k.token_prefix,k.scopes,k.created_at AS login_created_at,k.expires_at,k.last_used_at,
     k.live_activity_policy,k.max_active_cards
   FROM computers c JOIN principal_api_keys k ON k.id=c.login_key_id`;
const ACTIVE_LOGIN = "k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())";

/** The account's computers whose login still works, newest sign-in first. */
export async function listComputers(db: Queryable,principalId: string,limit: number): Promise<ComputerRow[]> {
  return (await db.query<ComputerRow>(
    `${SELECT_COMPUTER} WHERE c.principal_id=$1 AND ${ACTIVE_LOGIN} ORDER BY k.created_at DESC,c.id DESC LIMIT $2`,
    [principalId,limit],
  )).rows;
}

/** One of the account's computers by its internal id; a revoked or expired login finds nothing. */
export async function findComputer(db: Queryable,principalId: string,computerId: string): Promise<ComputerRow | undefined> {
  return (await db.query<ComputerRow>(
    `${SELECT_COMPUTER} WHERE c.id=$2 AND c.principal_id=$1 AND ${ACTIVE_LOGIN}`,
    [principalId,computerId],
  )).rows[0];
}

/** The computer of a login, by the login's id (for cards and hooks minted by that login). */
export async function findComputerByLogin(db: Queryable,loginKeyId: string): Promise<{ id: string } | undefined> {
  return (await db.query<{ id: string }>("SELECT id FROM computers WHERE login_key_id=$1",[loginKeyId])).rows[0];
}

/**
 * Renames a computer and/or sets its icon; `null` clears the field (back to the login's name, automatic icon).
 * Never edits the login's label. Returns false when the computer is not the account's or its login no longer works.
 */
export async function updateComputer(
  db: Runner,principalId: string,computerId: string,change: ComputerRename,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE computers c SET
       display_name=CASE WHEN $3::boolean THEN $4 ELSE c.display_name END,
       icon=CASE WHEN $5::boolean THEN $6 ELSE c.icon END,
       updated_at=now()
     FROM principal_api_keys k
     WHERE c.id=$1 AND c.principal_id=$2 AND k.id=c.login_key_id AND ${ACTIVE_LOGIN}
     RETURNING c.id`,
    [computerId,principalId,"name" in change,change.name ?? null,"icon" in change,change.icon ?? null],
  );
  return Boolean(result.rowCount);
}

/**
 * Stores the machine's report on its own computer (the login's), replacing the last one. The hash is computed here,
 * from the parsed report, never taken from the sender. Returns false when the login has no computer (a CI token).
 */
export async function storeComputerReport(db: Queryable,loginKeyId: string,report: ComputerReport): Promise<boolean> {
  await ensureComputer(db,loginKeyId);
  const hash = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  const result = await db.query(
    `UPDATE computers SET report=$2::jsonb,report_hash=$3,reported_at=now(),updated_at=now() WHERE login_key_id=$1 RETURNING id`,
    [loginKeyId,JSON.stringify(report),hash],
  );
  return Boolean(result.rowCount);
}
