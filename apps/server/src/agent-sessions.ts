import {
  AGENT_SESSION_PHASES,
  OWNER_STATE_TIMING,
  type AgentSessionCounts,
  type AgentSessionObservedRequest,
  type AgentSessionPhase,
  type AgentSessionSummary,
  type ObservedSessionPhase,
  type SessionRow,
  type SessionRowInput,
} from "@relo/notification-contracts";
import type { Database } from "./db.js";
import { deriveSessionRow } from "./derive/agent-session-evidence.js";
import { publicId } from "./ids.js";

/**
 * Agent sessions (the owner's "Sessions"): the last observed snapshot of each session, reported by
 * the CLI's local session state machine over the harness credential (ADR 0008: the CLI is the
 * edge). This module owns the table and its read model; it stores what was reported and never
 * interprets harness activity. Owner-facing phases (working, waiting, idle, ended) come from the
 * one session-row derivation (derive/agent-session-evidence.ts), never stored. A card names its
 * session (live_activities.session_key); a session never changes a card, question or work.
 */

/** The lists show sessions seen in this window. */
export const SESSION_LIST_WINDOW_HOURS = 24;
export const SESSION_LIST_MAX = 20;
/** At most this many stored rows are derived per read (newest first) before ranking and cutting to the list size. */
const SESSION_READ_MAX = 200;
/** Sessions not seen for this long are removed; nothing else references them. */
export const SESSION_RETENTION_DAYS = 7;
/** A client clock ahead of the server by more than this is clamped to the server's time. */
export const SESSION_FUTURE_SKEW_SECONDS = 300;

/**
 * Stores one observed snapshot. Applied only when its seq is greater than the stored one: a retry
 * or a late, older snapshot changes nothing, so delivery order and duplicates never matter. Times
 * ahead of the server's clock by more than the skew are clamped to it. Labels and sealed names
 * keep their stored value when a snapshot omits them. The snapshot is stored as reported: what a
 * phase means is derive()'s, never this module's. Returns whether the snapshot was applied.
 */
export async function recordObservedSnapshot(
  db: Pick<Database,"query">,
  principalId: string,
  input: AgentSessionObservedRequest,
): Promise<boolean> {
  const result = await db.query(
    `WITH clock AS (SELECT clock_timestamp()+make_interval(secs=>$13::double precision) AS latest),
     snapshot AS (
       SELECT LEAST($9::timestamptz,clock.latest) AS phase_since,LEAST($10::timestamptz,clock.latest) AS last_seen_at,
         CASE WHEN $11::timestamptz IS NULL THEN NULL ELSE LEAST($11::timestamptz,clock.latest) END AS open_tool_since
       FROM clock
     )
     INSERT INTO agent_sessions(principal_id,session_hash,harness,computer,account,project,sealed_names,
       phase,phase_since,last_seen_at,open_tool_since,seq,started_at)
     SELECT $1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text,$7::jsonb,$8::text,
       snapshot.phase_since,GREATEST(snapshot.last_seen_at,snapshot.phase_since),snapshot.open_tool_since,$12::bigint,
       snapshot.phase_since
     FROM snapshot
     ON CONFLICT (principal_id,session_hash) DO UPDATE SET
       harness=EXCLUDED.harness,
       computer=COALESCE(EXCLUDED.computer,agent_sessions.computer),
       account=COALESCE(EXCLUDED.account,agent_sessions.account),
       project=COALESCE(EXCLUDED.project,agent_sessions.project),
       sealed_names=COALESCE(EXCLUDED.sealed_names,agent_sessions.sealed_names),
       phase=EXCLUDED.phase,
       phase_since=EXCLUDED.phase_since,
       last_seen_at=EXCLUDED.last_seen_at,
       open_tool_since=EXCLUDED.open_tool_since,
       seq=EXCLUDED.seq,
       updated_at=now()
     WHERE agent_sessions.seq<EXCLUDED.seq`,
    [principalId,input.session,input.harness,input.computer ?? null,input.account ?? null,input.project ?? null,
      input.sealedNames === undefined ? null : JSON.stringify(input.sealedNames),input.phase,input.phaseSince,
      input.lastSeenAt,input.openToolSince,input.seq,SESSION_FUTURE_SKEW_SECONDS],
  );
  return Boolean(result.rowCount);
}

/**
 * SQL expression (a jsonb array of stored rows) for the recent sessions of the account in
 * `principal`, a SQL expression such as "$1". It is an expression so the inbox snapshot reads it
 * inside its single statement; `mapAgentSessionRows` derives each row's phase and turns the rows
 * into the contract shape. Each session carries its own card (same session key) and its last
 * declared write.
 */
export function agentSessionRowsSql(principal: string): string {
  return `(SELECT COALESCE(jsonb_agg(to_jsonb(y) ORDER BY y.last_seen_at DESC,y.id),'[]'::jsonb) FROM (
      SELECT s.id,s.session_hash,s.harness,s.computer,s.account,s.project,s.phase,s.phase_since,s.last_seen_at,
        s.started_at,s.sealed_names,
        card.id AS card_id,card.state AS card_state,card.updated_at AS card_updated_at,declared.at AS declared_at
      FROM agent_sessions s
      LEFT JOIN LATERAL (
        SELECT a.id,a.state::text AS state,a.updated_at FROM live_activities a
        WHERE a.principal_id=s.principal_id AND a.session_key=s.session_hash
          AND a.state='active' AND a.presentation IS NOT NULL
        ORDER BY a.updated_at DESC,a.id DESC LIMIT 1
      ) card ON true
      LEFT JOIN LATERAL (
        SELECT max(a.declared_at) AS at FROM live_activities a
        WHERE a.principal_id=s.principal_id AND a.session_key=s.session_hash
      ) declared ON true
      WHERE s.principal_id=${principal} AND s.last_seen_at>now()-interval '${SESSION_LIST_WINDOW_HOURS} hours'
      ORDER BY s.last_seen_at DESC,s.id LIMIT ${SESSION_READ_MAX}) y)`;
}

/** Phase order in the lists: working, waiting, idle, then ended. */
const PHASE_RANK: Record<AgentSessionPhase,number> = { working: 0,waiting: 1,idle: 2,ended: 3 };

const isoOf = (value: string | Date): string => new Date(value).toISOString();

/** The stored row's evidence for the session-row derivation. */
function sessionRowInput(row: any,now: Date): SessionRowInput {
  return {
    now: now.toISOString(),
    observed: { phase: row.phase,phaseSince: isoOf(row.phase_since),lastSeenAt: isoOf(row.last_seen_at) },
    lastDeclaredAt: row.declared_at ? isoOf(row.declared_at) : null,
  };
}

/**
 * `withSealedNames` only for phones: the Dashboard and the CLI never receive envelopes. Rows are
 * ranked by derived phase, then newest first, and cut to the list size.
 */
export function mapAgentSessionRows(rows: any[],{ withSealedNames = false,now = new Date(),phases }:
  { withSealedNames?: boolean; now?: Date; phases?: readonly AgentSessionPhase[] | undefined } = {}): AgentSessionSummary[] {
  return rankedSessions(rows,now)
    .filter(({ phase }) => !phases?.length || phases.includes(phase))
    .slice(0,SESSION_LIST_MAX)
    .map(({ row,phase,waitingFor }): AgentSessionSummary => {
      const quietFor = row.card_id ? Math.max(0,Math.floor((now.valueOf() - Math.max(
        new Date(row.card_updated_at).valueOf(),new Date(row.last_seen_at).valueOf())) / 1000)) : 0;
      return {
        id: publicId("ags",row.id),
        harness: row.harness,
        computer: row.computer ?? null,
        account: row.account ?? null,
        project: row.project ?? null,
        phase,
        waitingFor,
        startedAt: isoOf(row.started_at),
        lastSeenAt: isoOf(row.last_seen_at),
        card: row.card_id ? { id: publicId("act",row.card_id),state: row.card_state,quietForSeconds: quietFor } : null,
        presence: phase === "ended" ? "ended" : !row.card_id ? "no_card"
          : quietFor >= OWNER_STATE_TIMING.freshSeconds ? "quiet" : "working",
        ...(withSealedNames && row.sealed_names ? { sealedNames: row.sealed_names } : {}),
      };
    });
}


function rankedSessions(rows: any[],now: Date) {
  return rows.map((row) => {
    const derived = deriveSessionRow(sessionRowInput(row,now));
    // A stored row always has observed evidence, so the derivation always gives it a phase.
    return { row,derived,phase: (derived.phase ?? "idle") as AgentSessionPhase,waitingFor: derived.waitingFor };
  }).sort((a,b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase]
    || new Date(b.row.last_seen_at).valueOf() - new Date(a.row.last_seen_at).valueOf()
    || String(a.row.id).localeCompare(String(b.row.id)));
}

/** Rows of the Sessions view (owner-facing): hidden rows dropped, idle ones folded (spec 6.2). */
export function sessionsViewRows(rows: any[],now: Date,{ withSealedNames = false } = {}): SessionRow[] {
  const result: SessionRow[] = [];
  for (const { row,derived } of rankedSessions(rows,now)) {
    if (derived.hidden) continue;
    result.push({
      id: publicId("ags",row.id),source: row.harness ?? null,project: row.project ?? null,computer: row.computer ?? null,
      phase: derived.phase,observed: true,waitingFor: derived.waitingFor,lastSeenAt: derived.lastSeenAt,fold: derived.fold,
      workId: row.card_id ? publicId("act",row.card_id) : null,
      ...(withSealedNames && row.sealed_names ? { sealedNames: row.sealed_names } : {}),
      nextChangeAt: derived.nextChangeAt,
    });
  }
  return result;
}

/**
 * Hook-less agent sessions (spec 6.2 "without hooks: last seen"): cards with a session key that no
 * observed row reports. One row per key, from its newest card's declared write; hidden after T_retire.
 */
export function hooklessSessionRows(cards: readonly { id: string; sessionKey: string; declaredAt: Date; active: boolean;
  source: string | null; project: string | null; computer?: string | null }[],reportedKeys: ReadonlySet<string>,now: Date): SessionRow[] {
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
    rows.push({ id: publicId("act",card.id),source: card.source,project: card.project,computer: card.computer ?? null,phase: null,observed: false,
      waitingFor: null,lastSeenAt: derived.lastSeenAt,fold: null,workId: card.active ? publicId("act",card.id) : null,
      nextChangeAt: derived.nextChangeAt });
  }
  return rows.sort((a,b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}

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
  return { sessions: mapAgentSessionRows(rows,{ now,phases }),counts };
}

/** The observed evidence of one session, as stored: derive() reads it, nothing here interprets it. */
export type StoredSessionEvidence = {
  phase: ObservedSessionPhase; phaseSince: Date; lastSeenAt: Date; openToolSince: Date | null;
};

/**
 * The observed evidence of each given session key (derive() reads a card's own session only).
 * Keys with no reported snapshot are absent: those cards derive without hooks.
 */
export async function loadSessionEvidence(
  db: Pick<Database,"query">,principalId: string,sessionKeys: readonly string[],
): Promise<Map<string,StoredSessionEvidence>> {
  const evidence = new Map<string,StoredSessionEvidence>();
  if (!sessionKeys.length) return evidence;
  const rows = await db.query<{ session_hash: string; phase: ObservedSessionPhase; phase_since: Date; last_seen_at: Date;
    open_tool_since: Date | null }>(
    `SELECT session_hash,phase,phase_since,last_seen_at,open_tool_since FROM agent_sessions
     WHERE principal_id=$1 AND session_hash=ANY($2::text[])`,
    [principalId,[...new Set(sessionKeys)]]);
  for (const row of rows.rows) {
    evidence.set(row.session_hash,{ phase: row.phase,phaseSince: row.phase_since,lastSeenAt: row.last_seen_at,
      openToolSince: row.open_tool_since });
  }
  return evidence;
}

export type AgentSessionReconcileResult = { pruned: number };

/**
 * One idempotent pass, safe from any number of workers: sessions not seen for
 * SESSION_RETENTION_DAYS are removed. Nothing else is written: phases are derived at read time,
 * and no session state creates, changes or ends a card, a question or a work.
 */
export async function reconcileAgentSessions(db: Pick<Database,"query">): Promise<AgentSessionReconcileResult> {
  const pruned = await db.query(
    "DELETE FROM agent_sessions WHERE last_seen_at<now()-make_interval(days=>$1::int)",
    [SESSION_RETENTION_DAYS],
  );
  return { pruned: pruned.rowCount ?? 0 };
}
