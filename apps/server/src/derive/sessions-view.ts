import {
  type AgentSessionPhase,
  type AgentSessionSummary,
  type ComputerIcon,
  type SessionRow,
  type SessionRowDerived,
  type SessionRowInput,
} from "@relo/notification-contracts";
import { iconFromColumns } from "../computers/store.js";
import { publicId } from "../ids.js";
import { iso,ms,T } from "./clock.js";
import { presence,reconcile,type PresenceKind } from "./presence.js";

/**
 * The Sessions view (plan 14, workstream 5): one row per session, assembled from stored rows. What the session is
 * doing comes from the one presence function and the one reconcile rule (derive/presence.ts), the same result the
 * card reads (derive/agent-session-evidence.ts), mapped to the row as:
 *
 *   needs_input → waiting (input)   your_turn → waiting (turn)   working → working
 *   silent, idle → idle (folded after T_quiet, hidden after T_history)   ended → hidden
 *
 * A session that started and never prompted is hidden until its first prompt. Without hooks there is no phase:
 * "last seen" from the session's relo commands, hidden after T_retire. Storage (agent-sessions.ts) stores rows and
 * imports nothing from here; the reads that join the two live in agent-session-reads.ts.
 */
const ROW: Record<PresenceKind,{ phase: AgentSessionPhase; waitingFor: "input" | "turn" | null }> = {
  needs_input: { phase: "waiting",waitingFor: "input" },
  your_turn: { phase: "waiting",waitingFor: "turn" },
  working: { phase: "working",waitingFor: null },
  silent: { phase: "idle",waitingFor: null },
  idle: { phase: "idle",waitingFor: null },
  ended: { phase: "ended",waitingFor: null },
};

/** One row of the Sessions view from a session's observed evidence and its declared writes. */
export function deriveSessionRow(input: SessionRowInput): SessionRowDerived {
  const now = ms(input.now);
  const declared = input.lastDeclaredAt ? ms(input.lastDeclaredAt) : null;
  const observed = input.observed;
  if (!observed) {
    const lastSeen = declared ?? -Infinity;
    const hideAt = lastSeen + T.retire;
    return { phase: null,waitingFor: null,lastSeenAt: iso(lastSeen),fold: null,hidden: now >= hideAt,
      nextChangeAt: hideAt > now ? iso(hideAt) : null };
  }
  const turn = reconcile(presence(observed,now),{ lastDeclaredAt: declared,waitingSince: input.waitingSince ? ms(input.waitingSince) : null },now);
  const lastSeen = Math.max(ms(observed.lastSeenAt),declared ?? -Infinity);
  const { phase,waitingFor } = ROW[turn.kind];
  const idle = turn.kind === "idle" || turn.kind === "silent";
  const idleFor = now - lastSeen;
  const hidden = turn.kind === "ended" || (idle && (!turn.prompted || idleFor >= T.history));
  // The next change: the presence function's own, then the fold and the hiding of an idle row.
  const next = [...turn.changesAt,...(idle && turn.prompted ? [lastSeen + T.quiet,lastSeen + T.history] : [])]
    .filter((at) => at > now).sort((a,b) => a - b)[0];
  return { phase,waitingFor,lastSeenAt: iso(lastSeen),fold: idle && idleFor >= T.quiet ? "idle" : null,hidden,
    nextChangeAt: next === undefined ? null : iso(next) };
}

/** Phase order in the lists: working, waiting, idle, then ended. */
const PHASE_RANK: Record<AgentSessionPhase,number> = { working: 0,waiting: 1,idle: 2,ended: 3 };

/** Observed display facts (context use, cost); numeric arrives as text from the driver. Never read by the derivation. */
export function displayFacts(row: any): { contextPct?: number; costUsd?: number; contextTokens?: number } {
  return {
    ...(row.context_pct === null || row.context_pct === undefined ? {} : { contextPct: Number(row.context_pct) }),
    ...(row.cost_usd === null || row.cost_usd === undefined ? {} : { costUsd: Number(row.cost_usd) }),
    ...(row.context_tokens === null || row.context_tokens === undefined ? {} : { contextTokens: Number(row.context_tokens) }),
  };
}

const isoOf = (value: string | Date): string => new Date(value).toISOString();

/** The stored row's evidence for the session-row derivation. */
export function sessionRowInput(row: any,now: Date): SessionRowInput {
  return {
    now: now.toISOString(),
    observed: { phase: row.phase,phaseSince: isoOf(row.phase_since),lastSeenAt: isoOf(row.last_seen_at),
      openToolSince: row.open_tool_since ? isoOf(row.open_tool_since) : null,
      ...(row.heartbeat_at ? { heartbeatAt: isoOf(row.heartbeat_at) } : {}) },
    lastDeclaredAt: row.declared_at ? isoOf(row.declared_at) : null,
    waitingSince: row.waiting_since ? isoOf(row.waiting_since) : null,
  };
}

export function rankedSessions(rows: any[],now: Date) {
  return rows.map((row) => {
    const derived = deriveSessionRow(sessionRowInput(row,now));
    // A stored row always has observed evidence, so the derivation always gives it a phase.
    return { row,derived,phase: (derived.phase ?? "idle") as AgentSessionPhase,waitingFor: derived.waitingFor };
  }).sort((a,b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase]
    || new Date(b.row.last_seen_at).valueOf() - new Date(a.row.last_seen_at).valueOf()
    || String(a.row.id).localeCompare(String(b.row.id)));
}

/** The admin list's phases unless the caller names some: an ended session is gone. */
const LISTED_PHASES: readonly AgentSessionPhase[] = ["working","waiting","idle"];

/**
 * The owner/admin list (`relo admin sessions`): every row (ended sessions only when asked for by
 * phase), with its phase from the session-row derivation and its card's id and state. The owner's Sessions view
 * is `sessionsViewRows`. Rows are ranked by derived phase, then newest first.
 */
export function mapAgentSessionRows(rows: any[],{ now,phases,limit }:
  { now: Date; phases?: readonly AgentSessionPhase[] | undefined; limit: number }): AgentSessionSummary[] {
  return rankedSessions(rows,now)
    .filter(({ phase }) => (phases?.length ? phases : LISTED_PHASES).includes(phase))
    .slice(0,limit)
    .map(({ row,phase,waitingFor }): AgentSessionSummary => ({
      id: publicId("ags",row.id),
      harness: row.harness,
      computer: row.computer ?? null,
      account: row.account ?? null,
      project: row.project ?? null,
      phase,
      waitingFor,
      startedAt: isoOf(row.started_at),
      lastSeenAt: isoOf(row.last_seen_at),
      ...displayFacts(row),
      card: row.card_id ? { id: publicId("act",row.card_id),state: row.card_state } : null,
    }));
}

/**
 * A session's readable name: the title its snapshots carried (unencrypted accounts), else, when the session has no name
 * at all (no readable title and no sealed names), the goal of its open card, so the row is never nameless.
 */
function sessionTitle(row: any,goalByKey: ReadonlyMap<string,string> | undefined): { title?: string } {
  if (typeof row.title === "string" && row.title) return { title: row.title };
  const goal = row.sealed_names ? undefined : goalByKey?.get(row.session_hash);
  return goal ? { title: goal } : {};
}

/** Rows of the Sessions view (owner-facing): hidden rows dropped, idle ones folded (spec 6.2). */
export function sessionsViewRows(rows: any[],now: Date,{ withSealedNames = false,goalByKey }:
  { withSealedNames?: boolean; goalByKey?: ReadonlyMap<string,string> } = {}): SessionRow[] {
  const result: SessionRow[] = [];
  for (const { row,derived } of rankedSessions(rows,now)) {
    if (derived.hidden) continue;
    result.push({
      id: publicId("ags",row.id),source: row.harness ?? null,project: row.project ?? null,computer: row.computer ?? null,
      ...(row.computer_row ? { computerIcon: iconFromColumns(row.computer_icon,row.computer_kind).icon } : {}),
      phase: derived.phase,observed: true,waitingFor: derived.waitingFor,lastSeenAt: derived.lastSeenAt,fold: derived.fold,
      workId: row.card_id ? publicId("act",row.card_id) : null,
      ...(withSealedNames && row.sealed_names ? { sealedNames: row.sealed_names } : {}),
      ...sessionTitle(row,goalByKey),
      nextChangeAt: derived.nextChangeAt,
      ...displayFacts(row),
    });
  }
  return result;
}

/**
 * Hook-less agent sessions (spec 6.2 "without hooks: last seen"): cards with a session key that no
 * observed row reports. One row per key, from its newest card's declared write; hidden after T_retire.
 */
export function hooklessSessionRows(cards: readonly { id: string; sessionKey: string; declaredAt: Date; active: boolean;
  source: string | null; project: string | null; computer?: string | null; computerIcon?: ComputerIcon }[],reportedKeys: ReadonlySet<string>,now: Date): SessionRow[] {
  const newest = new Map<string,(typeof cards)[number]>();
  for (const card of cards) {
    if (reportedKeys.has(card.sessionKey)) continue;
    const seen = newest.get(card.sessionKey);
    if (!seen || card.declaredAt > seen.declaredAt) newest.set(card.sessionKey,card);
  }
  const rows: SessionRow[] = [];
  for (const card of newest.values()) {
    const derived = deriveSessionRow({ now: now.toISOString(),observed: null,lastDeclaredAt: card.declaredAt.toISOString() });
    if (derived.hidden) continue;
    rows.push({ id: publicId("act",card.id),source: card.source,project: card.project,computer: card.computer ?? null,
      ...(card.computerIcon ? { computerIcon: card.computerIcon } : {}),phase: null,observed: false,
      waitingFor: null,lastSeenAt: derived.lastSeenAt,fold: null,workId: card.active ? publicId("act",card.id) : null,
      nextChangeAt: derived.nextChangeAt });
  }
  return rows.sort((a,b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}
