import {
  type AgentSessionObservedRequest,
  type ObservedSessionPhase,
} from "@relo/notification-contracts";
import type { Database } from "./db.js";
import { computerIconColumns } from "./computers/store.js";
import { publicId } from "./ids.js";

/**
 * Agent sessions (the owner's "Sessions"): the last observed snapshot of each session, reported by
 * the CLI's local session state machine over the harness credential (ADR 0008: the CLI is the
 * edge). This module owns the table and its read model; it stores what was reported and never
 * interprets harness activity. Owner-facing phases (working, waiting, idle, ended) come from the
 * Sessions view (derive/sessions-view.ts, read through agent-session-reads.ts), never stored; this module imports nothing from derive/. A card names its
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
 * phase means is derive()'s, never this module's. A snapshot that changes the phase also appends one
 * row to the transition log (agent_session_transitions) in the same statement, so false "Needs you"
 * and time to clear can be measured. Returns whether the snapshot was applied.
 */
export async function recordObservedSnapshot(
  db: Pick<Database,"connect">,
  principalId: string,
  input: AgentSessionObservedRequest,
): Promise<boolean> {
  // One transaction per snapshot: the session's lock is taken first, so the phase read as "previous"
  // is the one this snapshot replaces even when two snapshots for the session arrive together.
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // The advisory lock also covers a session's first snapshot, where no row exists to lock yet.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",[`${principalId}:${input.session}`]);
    const current = (await client.query(
      "SELECT phase,last_seen_at FROM agent_sessions WHERE principal_id=$1::uuid AND session_hash=$2::text FOR UPDATE",
      [principalId,input.session])).rows[0] as { phase: string; last_seen_at: Date } | undefined;
    const applied = await upsertSnapshot(client,principalId,input,current?.phase ?? null,current?.last_seen_at ?? null);
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function upsertSnapshot(
  db: Pick<Database,"query">,
  principalId: string,
  input: AgentSessionObservedRequest,
  previousPhase: string | null,
  previousLastSeenAt: Date | null,
): Promise<boolean> {
  const result = await db.query(
    `WITH clock AS (SELECT clock_timestamp()+make_interval(secs=>$13::double precision) AS latest),
     snapshot AS (
       SELECT LEAST($9::timestamptz,clock.latest) AS phase_since,LEAST($10::timestamptz,clock.latest) AS last_seen_at,
         CASE WHEN $11::timestamptz IS NULL THEN NULL ELSE LEAST($11::timestamptz,clock.latest) END AS open_tool_since
       FROM clock
     ),
     applied AS (
       INSERT INTO agent_sessions(principal_id,session_hash,harness,computer,account,project,sealed_names,
         title,phase,phase_since,last_seen_at,open_tool_since,seq,started_at,context_pct,cost_usd,context_tokens,heartbeat_at)
       SELECT $1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text,$7::jsonb,$21::text,$8::text,
         snapshot.phase_since,GREATEST(snapshot.last_seen_at,snapshot.phase_since),snapshot.open_tool_since,$12::bigint,
         snapshot.phase_since,$14::smallint,$15::numeric,$16::integer,
         CASE WHEN $20::boolean THEN snapshot.last_seen_at END
       FROM snapshot
       ON CONFLICT (principal_id,session_hash) DO UPDATE SET
         harness=EXCLUDED.harness,
         computer=COALESCE(EXCLUDED.computer,agent_sessions.computer),
         account=COALESCE(EXCLUDED.account,agent_sessions.account),
         project=COALESCE(EXCLUDED.project,agent_sessions.project),
         sealed_names=COALESCE(EXCLUDED.sealed_names,agent_sessions.sealed_names),
         title=COALESCE(EXCLUDED.title,agent_sessions.title),
         phase=EXCLUDED.phase,
         phase_since=EXCLUDED.phase_since,
         last_seen_at=EXCLUDED.last_seen_at,
         open_tool_since=EXCLUDED.open_tool_since,
         context_pct=COALESCE(EXCLUDED.context_pct,agent_sessions.context_pct),
         cost_usd=COALESCE(EXCLUDED.cost_usd,agent_sessions.cost_usd),
         context_tokens=COALESCE(EXCLUDED.context_tokens,agent_sessions.context_tokens),
         heartbeat_at=CASE WHEN $20::boolean THEN EXCLUDED.heartbeat_at
           WHEN EXCLUDED.phase IS DISTINCT FROM agent_sessions.phase THEN NULL
           ELSE agent_sessions.heartbeat_at END,
         seq=EXCLUDED.seq,
         updated_at=now()
       WHERE agent_sessions.seq<EXCLUDED.seq
       RETURNING id,phase,phase_since
     ),
     logged AS (
       INSERT INTO agent_session_transitions(session_id,previous_phase,previous_last_seen_at,new_phase,phase_since,end_reason)
       SELECT applied.id,$18::text,$19::timestamptz,applied.phase,applied.phase_since,$17::text
       FROM applied
       WHERE $18::text IS DISTINCT FROM applied.phase
     )
     SELECT count(*)::int AS applied FROM applied`,
    [principalId,input.session,input.harness,input.computer ?? null,input.account ?? null,input.project ?? null,
      input.sealedNames === undefined ? null : JSON.stringify(input.sealedNames),input.phase,input.phaseSince,
      input.lastSeenAt,input.openToolSince,input.seq,SESSION_FUTURE_SKEW_SECONDS,input.contextPct ?? null,input.costUsd ?? null,input.contextTokens ?? null,
      input.phase === "ended" ? input.endReason ?? null : null,previousPhase,previousLastSeenAt,input.heartbeat === true,input.title ?? null],
  );
  return result.rows[0].applied > 0;
}

/**
 * SQL expression (a jsonb array of stored rows) for the recent sessions of the account in
 * `principal`, a SQL expression such as "$1". It is an expression so the inbox snapshot reads it
 * inside its single statement; the Sessions view derives each row's phase and turns the rows
 * into the contract shape. Each session carries its own card (same session key) and its last
 * declared write.
 */
export function agentSessionRowsSql(principal: string): string {
  return `(SELECT COALESCE(jsonb_agg(to_jsonb(y) ORDER BY y.last_seen_at DESC,y.id),'[]'::jsonb) FROM (
      SELECT s.id,s.session_hash,s.harness,s.computer,s.account,s.project,s.phase,s.phase_since,s.last_seen_at,s.open_tool_since,s.heartbeat_at,s.context_pct,s.cost_usd,s.context_tokens,
        s.started_at,s.sealed_names,s.title,
        card.id AS card_id,card.state AS card_state,card.updated_at AS card_updated_at,declared.at AS declared_at,
        machine.computer_icon,machine.computer_kind,machine.computer_row,waiting.since AS waiting_since
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
      LEFT JOIN LATERAL (
        SELECT max(w.waiting_since) AS since FROM works w
        WHERE w.principal_id=s.principal_id AND w.session_key=s.session_hash AND w.lifecycle='open'
      ) waiting ON true
      LEFT JOIN LATERAL (
        SELECT ${computerIconColumns("c")},true AS computer_row FROM works w
        JOIN computers c ON c.login_key_id=w.credential_id AND c.principal_id=w.principal_id
        WHERE w.principal_id=s.principal_id AND w.session_key=s.session_hash
        ORDER BY w.updated_at DESC,w.id DESC LIMIT 1
      ) machine ON true
      WHERE s.principal_id=${principal} AND s.last_seen_at>now()-interval '${SESSION_LIST_WINDOW_HOURS} hours'
      ORDER BY s.last_seen_at DESC,s.id LIMIT ${SESSION_READ_MAX}) y)`;
}

/** The handles an agent session's sealed names cover: its project, computer and account (`p-`, `c-`, `a-`). */
const SESSION_HANDLE = /^[pca]-[a-z2-7]{16}$/u;
/** At most this many handles are looked up and session ids returned for one page. */
const NAMES_FROM_HANDLES_MAX = 200;
export const NAMES_FROM_MAX = 20;

/**
 * A session's label over the card's own: the session's wins (Now and Sessions name the same computer and project),
 * except a handle over a readable name, which would turn a name everyone can read into one only sealed names open.
 */
export function sessionLabelOver(sessionValue: string | null | undefined,cardValue: string | null | undefined): string | null {
  const session = sessionValue ?? null;
  if (session && SESSION_HANDLE.test(session.trim()) && cardValue && !SESSION_HANDLE.test(cardValue.trim())) return cardValue;
  return session ?? cardValue ?? null;
}

/** The session-named handles anywhere in a page value, in the order they appear. */
export function sessionHandlesIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    if (SESSION_HANDLE.test(value.trim())) into.add(value.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) sessionHandlesIn(item,into);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) sessionHandlesIn(child,into);
  }
  return into;
}

/**
 * The agent sessions (`ags_…`, newest per handle) whose sealed names envelope covers one of
 * `handles`, so a linked browser can name a page's handles where the page's own envelopes do not
 * (a card's later updates seal its text without the names). Only ids leave the server: the names
 * stay sealed, and a browser opens them through GET /api/dashboard/sealed like Now's sessions.
 */
export async function sessionsNamingHandles(
  db: Pick<Database,"query">,
  principalId: string,
  handles: Iterable<string>,
): Promise<string[]> {
  const wanted = [...new Set(handles)].filter((handle) => SESSION_HANDLE.test(handle)).slice(0,NAMES_FROM_HANDLES_MAX);
  if (!wanted.length) return [];
  const rows = await db.query<{ id: string }>(
    `SELECT named.id FROM (
       SELECT DISTINCT ON (h.handle) h.ord,s.id
       FROM unnest($2::text[]) WITH ORDINALITY h(handle,ord)
       JOIN agent_sessions s ON s.principal_id=$1 AND s.sealed_names IS NOT NULL
         AND h.handle IN (s.project,s.computer,s.account)
       ORDER BY h.handle,s.last_seen_at DESC,s.id
     ) named ORDER BY named.ord`,
    [principalId,wanted],
  );
  return [...new Set(rows.rows.map((row) => publicId("ags",String(row.id))))].slice(0,NAMES_FROM_MAX);
}

/** The observed evidence of one session, as stored: derive() reads it, nothing here interprets it. */
export type StoredSessionEvidence = {
  phase: ObservedSessionPhase; phaseSince: Date; lastSeenAt: Date; openToolSince: Date | null; heartbeatAt: Date | null;
  /** The session's own labels (project, computer): the one place Now and Sessions read them from. */
  project: string | null; computer: string | null;
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
    open_tool_since: Date | null; heartbeat_at: Date | null; project: string | null; computer: string | null }>(
    `SELECT session_hash,phase,phase_since,last_seen_at,open_tool_since,heartbeat_at,project,computer FROM agent_sessions
     WHERE principal_id=$1 AND session_hash=ANY($2::text[])`,
    [principalId,[...new Set(sessionKeys)]]);
  for (const row of rows.rows) {
    evidence.set(row.session_hash,{ phase: row.phase,phaseSince: row.phase_since,lastSeenAt: row.last_seen_at,
      openToolSince: row.open_tool_since,heartbeatAt: row.heartbeat_at,project: row.project,computer: row.computer });
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
  await db.query("DELETE FROM agent_session_transitions WHERE recorded_at<now()-make_interval(days=>$1::int)",[SESSION_RETENTION_DAYS]);
  return { pruned: pruned.rowCount ?? 0 };
}
