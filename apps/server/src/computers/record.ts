import type { Database } from "../db.js";
import { publicId } from "../ids.js";
import { effectivePresentationPolicy,parsePresentationPolicy } from "../presentation-policy.js";
import { computerReportSchema } from "@relo/notification-contracts";
import type { ConnectionComputer } from "@relo/notification-contracts/dashboard/connections";
import { computerDisplayName,effectiveIcon,findComputer,listComputers,type ComputerRow } from "./store.js";
import { computerFacts,type ComputerFacts } from "./summary.js";

type Queryable = Pick<Database,"query">;

const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

/** The account's default Live Activity policy, which a computer without its own inherits. */
async function accountPolicy(db: Queryable,principalId: string): Promise<unknown> {
  const result = await db.query<{ live_activity_policy: unknown }>(
    "SELECT live_activity_policy FROM owner_principals WHERE id=$1 AND disabled_at IS NULL",[principalId],
  );
  return result.rows[0]?.live_activity_policy ?? null;
}

/** The stored report, or null when none was sent (or an older shape no longer parses: the next report replaces it). */
function storedReport(value: unknown): ConnectionComputer["report"] {
  if (value == null) return null;
  const parsed = computerReportSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One computer as the Connections page shows it. */
export function computerRecord(row: ComputerRow,facts: ComputerFacts | undefined,inherited: unknown): ConnectionComputer {
  const resolved = effectivePresentationPolicy(row.live_activity_policy,inherited,"client");
  const icon = effectiveIcon(row);
  return {
    id: publicId("cmp",row.id),
    loginId: publicId("key",row.login_key_id),
    name: computerDisplayName(row),
    label: row.label,
    icon: icon.icon,
    iconSource: icon.source,
    tools: facts?.tools ?? [],
    openCards: facts?.openCards ?? 0,
    lastSeenAt: facts?.lastSeenAt ?? iso(row.last_used_at),
    createdAt: iso(row.login_created_at),
    expiresAt: iso(row.expires_at),
    prefix: row.token_prefix,
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
    encryption: facts?.encryption ?? "no_keys",
    hooks: facts?.hooks ?? [],
    liveActivityPolicy: parsePresentationPolicy(row.live_activity_policy),
    effectiveLiveActivityPolicy: resolved.policy,
    liveActivityPolicySource: resolved.source as "client" | "account" | "system",
    maxActiveCards: row.max_active_cards == null ? null : Number(row.max_active_cards),
    report: storedReport(row.report),
    reportedAt: iso(row.reported_at),
  };
}

/** The account's computers with their facts, for the Connections bootstrap. */
export async function loadComputerRecords(db: Queryable,principalId: string,limit: number,inherited?: unknown): Promise<ConnectionComputer[]> {
  const [rows,policy] = await Promise.all([
    listComputers(db,principalId,limit),
    inherited === undefined ? accountPolicy(db,principalId) : Promise.resolve(inherited),
  ]);
  const facts = await computerFacts(db,rows.map((row) => row.id));
  return rows.map((row) => computerRecord(row,facts.get(row.id),policy));
}

/** One computer's record by internal id (after a rename), or undefined. */
export async function loadComputerRecord(db: Queryable,principalId: string,computerId: string): Promise<ConnectionComputer | undefined> {
  const row = await findComputer(db,principalId,computerId);
  if (!row) return undefined;
  const [facts,policy] = await Promise.all([computerFacts(db,[row.id]),accountPolicy(db,principalId)]);
  return computerRecord(row,facts.get(row.id),policy);
}
