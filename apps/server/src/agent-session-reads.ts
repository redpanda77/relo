import {
  AGENT_SESSION_PHASES,
  type AgentSessionCounts,
  type AgentSessionPhase,
  type AgentSessionSummary,
} from "@relo/notification-contracts";
import type { Database } from "./db.js";
import { agentSessionRowsSql,SESSION_LIST_MAX } from "./agent-sessions.js";
import { mapAgentSessionRows,rankedSessions } from "./derive/sessions-view.js";

/**
 * The admin sessions listing: the stored rows (agent-sessions.ts, which imports nothing from derive/) read through
 * the Sessions view derivation (derive/sessions-view.ts). The one module that joins the two for `relo admin sessions`.
 */

/**
 * Recent sessions of an account with how each relates to its card, optionally only some phases.
 */
export async function listAgentSessions(
  db: Pick<Database,"query">,
  principalId: string,
  { phases }: { phases?: readonly AgentSessionPhase[] | undefined } = {},
): Promise<AgentSessionSummary[]> {
  return (await readAgentSessions(db,principalId,{ phases })).sessions;
}

/** The listing and, whatever the filter, how many sessions of the list window are in each phase. */
export async function readAgentSessions(
  db: Pick<Database,"query">,
  principalId: string,
  { phases }: { phases?: readonly AgentSessionPhase[] | undefined } = {},
): Promise<{ sessions: AgentSessionSummary[]; counts: AgentSessionCounts }> {
  const result = await db.query<{ sessions: any[]; now: Date }>(
    `SELECT ${agentSessionRowsSql("$1::uuid")} AS sessions,statement_timestamp() AS now`,[principalId]);
  const rows = result.rows[0]?.sessions ?? [];
  const now = result.rows[0]?.now ?? new Date();
  const counts = Object.fromEntries(AGENT_SESSION_PHASES.map(phase => [phase,0])) as AgentSessionCounts;
  for (const { phase } of rankedSessions(rows,now)) counts[phase] += 1;
  return { sessions: mapAgentSessionRows(rows,{ now,phases,limit: SESSION_LIST_MAX }),counts };
}
