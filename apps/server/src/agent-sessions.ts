import {
  AGENT_SESSION_PHASES,
  AGENT_SESSION_WAITING_AFTER_STOP_SECONDS,
  AGENT_SESSION_WAITING_ON_PROMPT_SECONDS,
  type AgentSessionCounts,
  type AgentSessionEventName,
  type AgentSessionPhase,
} from "@relo/notification-contracts";
import type {
  AgentSessionEventRequest,
  AgentSessionState,
  AgentSessionSummary,
} from "@relo/notification-contracts";
import { recordTerminalOperation } from "./activity-commands/runtime.js";
import type { ApnsMode } from "./activity-commands/schemas.js";
import type { Database } from "./db.js";
import { publicId } from "./ids.js";
import { terminalPresentationColumnsFromRow } from "./presentation-runtime.js";

/**
 * Agent sessions are facts reported by harness hooks on their own channel; they never carry card
 * content. This module owns the table, its read model and the one reconciler that applies the
 * session rules to cards (docs/internal/product/CLI-AGENT-INTEGRATION-PLAN.md, Phase 4).
 */

/** No event for this long in the middle of a turn and the session is lost (tool events arrive about once a minute). */
export const SESSION_LOST_AFTER_SECONDS = 15 * 60;
/**
 * An idle session (turn over, waiting for the owner) sends nothing until the owner replies, so
 * silence is normal: it is lost only after this long, the longest a card can live.
 */
export const SESSION_IDLE_LOST_AFTER_SECONDS = 8 * 60 * 60;
/** A lost session's card ends this long after the session became lost. */
export const SESSION_LOST_CARD_GRACE_SECONDS = 10 * 60;
/** The lists show sessions with an event in this window. */
export const SESSION_LIST_WINDOW_HOURS = 24;
export const SESSION_LIST_MAX = 20;
/** Settled sessions are removed after this long; nothing else references them. */
export const SESSION_RETENTION_DAYS = 7;
/** A client clock ahead of the server by more than this is clamped to the server's time. */
export const SESSION_FUTURE_SKEW_SECONDS = 300;
/** Cards ended per reconciler pass; the next pass continues. */
const RECONCILE_BATCH = 50;

export const SESSION_CARD_STATUS_ENDED = "Session ended";
export const SESSION_CARD_STATUS_LOST = "Session lost";

/**
 * SQL condition: the session in `alias` is between turns, so silence is normal: it stopped, waits on
 * a prompt, or only started (a Desktop session opened and not prompted yet).
 */
function betweenTurnsSql(alias: string): string {
  return `(${alias}.state='idle' OR (${alias}.state='active' AND ${alias}.last_event='start'))`;
}

/** SQL condition: the session in `alias` has been silent past its state's lost threshold. */
export function sessionSilentSql(alias: string): string {
  return `((${alias}.state='active' AND NOT ${betweenTurnsSql(alias)}
      AND ${alias}.last_event_at<=now()-interval '${SESSION_LOST_AFTER_SECONDS} seconds')
    OR (${betweenTurnsSql(alias)} AND ${alias}.last_event_at<=now()-interval '${SESSION_IDLE_LOST_AFTER_SECONDS} seconds'))`;
}

/** Phase order in the lists: working, waiting, idle, then the settled ones. */
const phaseRankSql = (column: string) => `CASE ${column} WHEN 'working' THEN 0 WHEN 'waiting' THEN 1 WHEN 'idle' THEN 2 ELSE 3 END`;

/** SQL expression: the phase of the session in `alias` now (agentSessionPhase in the contracts). */
export function sessionPhaseSql(alias: string): string {
  return `CASE
    WHEN ${sessionSilentSql(alias)} THEN 'lost'
    WHEN ${alias}.state IN ('ended','lost') THEN ${alias}.state
    WHEN ${alias}.state='active' AND ${alias}.last_event<>'start' THEN 'working'
    WHEN ${alias}.last_event='wait'
      AND ${alias}.last_event_at>now()-interval '${AGENT_SESSION_WAITING_ON_PROMPT_SECONDS} seconds' THEN 'waiting'
    WHEN ${alias}.last_event='stop'
      AND ${alias}.last_event_at>now()-interval '${AGENT_SESSION_WAITING_AFTER_STOP_SECONDS} seconds' THEN 'waiting'
    ELSE 'idle' END`;
}

/** A wait (permission or input prompt) is stored like a stop: between turns, the card rules agree. */
const STATE_AFTER_EVENT: Record<AgentSessionEventName, AgentSessionState> = {
  start: "active", prompt: "active", tool: "active", stop: "idle", wait: "idle", end: "ended",
};

/**
 * Stores one event. Idempotent (the same event again leaves the same row) and ordered by the
 * event's own time: an event older than the newest one seen changes nothing. An ended session is
 * brought back only by a strictly newer start, prompt or tool event; a stop or wait never revives it.
 * Returns the stored state after the event.
 */
export async function recordAgentSessionEvent(
  db: Pick<Database,"query">,
  principalId: string,
  input: AgentSessionEventRequest,
): Promise<AgentSessionState> {
  const result = await db.query<{ state: AgentSessionState }>(
    `WITH clock AS (
       SELECT LEAST(COALESCE($4::timestamptz,clock_timestamp()),
         clock_timestamp()+make_interval(secs=>$11::double precision)) AS at
     )
     INSERT INTO agent_sessions(principal_id,session_hash,harness,computer,account,project,state,
       started_at,last_event_at,last_event,ended_at,ended_reason,card_key,sealed_names)
     SELECT $1::uuid,$2::text,$3::text,$5::text,$6::text,$7::text,$8::text,clock.at,clock.at,$9::text,
       CASE WHEN $9::text='end' THEN clock.at END,CASE WHEN $9::text='end' THEN 'session_end' END,$10::text,$12::jsonb
     FROM clock
     ON CONFLICT (principal_id,session_hash) DO UPDATE SET
       harness=EXCLUDED.harness,
       computer=COALESCE(EXCLUDED.computer,agent_sessions.computer),
       account=COALESCE(EXCLUDED.account,agent_sessions.account),
       project=COALESCE(EXCLUDED.project,agent_sessions.project),
       card_key=COALESCE(EXCLUDED.card_key,agent_sessions.card_key),
       sealed_names=COALESCE(EXCLUDED.sealed_names,agent_sessions.sealed_names),
       state=EXCLUDED.state,
       started_at=CASE WHEN EXCLUDED.last_event='start' AND agent_sessions.state IN ('ended','lost')
         THEN EXCLUDED.last_event_at ELSE agent_sessions.started_at END,
       last_event_at=EXCLUDED.last_event_at,
       -- A start in the middle of a turn (SessionStart after a compaction) keeps it working.
       last_event=CASE WHEN EXCLUDED.last_event='start' AND agent_sessions.state='active'
         THEN agent_sessions.last_event ELSE EXCLUDED.last_event END,
       ended_at=CASE
         WHEN EXCLUDED.state<>'ended' THEN NULL
         WHEN agent_sessions.state='ended' THEN agent_sessions.ended_at
         ELSE EXCLUDED.last_event_at END,
       ended_reason=CASE WHEN EXCLUDED.state='ended' THEN 'session_end' END,
       updated_at=now()
     WHERE agent_sessions.last_event_at<=EXCLUDED.last_event_at
       AND (agent_sessions.state<>'ended'
         OR EXCLUDED.last_event='end'
         OR (EXCLUDED.last_event IN ('start','prompt','tool')
           AND EXCLUDED.last_event_at>agent_sessions.last_event_at))
     RETURNING state`,
    [principalId,input.session,input.harness,input.at ?? null,input.computer ?? null,input.account ?? null,
      input.project ?? null,STATE_AFTER_EVENT[input.event],input.event,input.cardKey ?? null,
      SESSION_FUTURE_SKEW_SECONDS,input.sealedNames === undefined ? null : JSON.stringify(input.sealedNames)],
  );
  if (result.rows[0]) return result.rows[0].state;
  // An older or non-reviving event: report what is stored.
  const stored = await db.query<{ state: AgentSessionState }>(
    "SELECT state FROM agent_sessions WHERE principal_id=$1 AND session_hash=$2",[principalId,input.session]);
  return stored.rows[0]?.state ?? STATE_AFTER_EVENT[input.event];
}

/**
 * SQL expression (a jsonb array of raw rows) for the live and recent sessions of the account in
 * `principal`, a SQL expression such as "$1". It is an expression so the inbox snapshot reads it
 * inside its single statement; `mapAgentSessionRows` turns the rows into the contract shape.
 */
export function agentSessionRowsSql(principal: string,phases?: readonly AgentSessionPhase[]): string {
  const filter = phases?.length ? `WHERE x.phase IN (${phases.map(phase => `'${phaseLiteral(phase)}'`).join(",")})` : "";
  return `(SELECT COALESCE(jsonb_agg(to_jsonb(y) ORDER BY y.ord),'[]'::jsonb) FROM (
    SELECT x.*,row_number() OVER (ORDER BY ${phaseRankSql("x.phase")},x.last_event_at DESC,x.id) AS ord
    FROM (
      SELECT s.id,s.harness,s.computer,s.account,s.project,s.started_at,s.last_event_at,s.last_event,s.sealed_names,
        CASE WHEN ${sessionSilentSql("s")} THEN 'lost' ELSE s.state END AS state,
        ${sessionPhaseSql("s")} AS phase,
        card.id AS card_id,card.state AS card_state,
        floor(extract(epoch FROM GREATEST(now()-card.updated_at,interval '0')))::int AS card_quiet_seconds,
        (card.stale_at IS NOT NULL AND card.stale_at<=now()) AS card_past_stale
      FROM agent_sessions s
      LEFT JOIN LATERAL (
        SELECT a.id,a.state::text AS state,a.updated_at,a.stale_at FROM live_activities a
        WHERE s.card_key IS NOT NULL AND a.principal_id=s.principal_id AND a.activity_key=s.card_key
          AND a.state='active' AND a.presentation IS NOT NULL
        ORDER BY a.updated_at DESC,a.id DESC LIMIT 1
      ) card ON true
      WHERE s.principal_id=${principal} AND s.last_event_at>now()-interval '${SESSION_LIST_WINDOW_HOURS} hours'
    ) x ${filter}
    ORDER BY ord LIMIT ${SESSION_LIST_MAX}) y)`;
}

/** Only the known phase names reach the SQL text. */
function phaseLiteral(phase: AgentSessionPhase): AgentSessionPhase {
  if (!(AGENT_SESSION_PHASES as readonly string[]).includes(phase)) throw new Error(`unknown phase ${phase}`);
  return phase;
}

/** SQL expression (a jsonb object): the account's sessions in the list window by phase, all phases present. */
export function agentSessionCountsSql(principal: string): string {
  return `(SELECT jsonb_build_object(${AGENT_SESSION_PHASES.map(phase =>
    `'${phase}',count(*) FILTER (WHERE c.phase='${phase}')`).join(",")}) FROM (
      SELECT ${sessionPhaseSql("s")} AS phase FROM agent_sessions s
      WHERE s.principal_id=${principal} AND s.last_event_at>now()-interval '${SESSION_LIST_WINDOW_HOURS} hours') c)`;
}

/** `withSealedNames` only for phones: the Dashboard and the CLI never receive envelopes. */
export function mapAgentSessionRows(rows: any[],{ withSealedNames = false } = {}): AgentSessionSummary[] {
  return rows.map((row): AgentSessionSummary => {
    const state = row.state as AgentSessionState;
    const live = state === "active" || state === "idle";
    return {
      id: publicId("ags",row.id),
      harness: row.harness,
      computer: row.computer ?? null,
      account: row.account ?? null,
      project: row.project ?? null,
      state,
      phase: row.phase as AgentSessionPhase,
      lastEvent: row.last_event as AgentSessionEventName,
      startedAt: new Date(row.started_at).toISOString(),
      lastEventAt: new Date(row.last_event_at).toISOString(),
      card: row.card_id ? {
        id: publicId("act",row.card_id),
        state: row.card_state,
        quietForSeconds: Math.max(0,Number(row.card_quiet_seconds)),
      } : null,
      presence: state === "ended" ? "ended" : state === "lost" ? "lost"
        : !live || !row.card_id ? "no_card" : row.card_past_stale ? "quiet" : "working",
      ...(withSealedNames && row.sealed_names ? { sealedNames: row.sealed_names } : {}),
    };
  });
}

/**
 * Live and recent sessions of an account with how each relates to its card, optionally only some
 * phases. A session silent past the lost threshold reads as lost even before the worker records it.
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
  const result = await db.query<{ sessions: any[]; counts: AgentSessionCounts }>(
    `SELECT ${agentSessionRowsSql("$1::uuid",phases)} AS sessions,${agentSessionCountsSql("$1::uuid")} AS counts`,[principalId]);
  const counts = Object.fromEntries(AGENT_SESSION_PHASES.map(phase =>
    [phase,Number(result.rows[0]?.counts?.[phase] ?? 0)])) as AgentSessionCounts;
  return { sessions: mapAgentSessionRows(result.rows[0]?.sessions ?? []),counts };
}

export type AgentSessionReconcileResult = { lost: number; cardsEnded: number; pruned: number };

/**
 * One idempotent pass over the session rules, safe to run from any number of workers:
 *  1. Mid-turn with no event for SESSION_LOST_AFTER_SECONDS, or between turns (stopped, waiting on a
 *     prompt, or only started) for SESSION_IDLE_LOST_AFTER_SECONDS, becomes lost.
 *  2. The active card of an ended session, or of a session lost for SESSION_LOST_CARD_GRACE_SECONDS,
 *     ends ("Session ended" / "Session lost") through the same terminal path as card expiry, unless
 *     a question on it is still open; the pass after the question settles ends it.
 *  3. Settled sessions older than SESSION_RETENTION_DAYS are removed.
 * A live session never ends its card: a card past its stale window only reads as quiet. While the
 * session is mid-turn the card is kept (see expireDueActivities); once the turn is over the
 * ordinary card expiry rules are in charge of it.
 */
export async function reconcileAgentSessions(
  db: Database,
  apnsMode: ApnsMode,
): Promise<AgentSessionReconcileResult> {
  const lost = await db.query(
    `UPDATE agent_sessions s SET state='lost',
       ended_at=s.last_event_at+make_interval(secs=>CASE WHEN ${betweenTurnsSql("s")} THEN $2::double precision ELSE $1::double precision END),
       ended_reason='lost',updated_at=now()
     WHERE ${sessionSilentSql("s")}`,
    [SESSION_LOST_AFTER_SECONDS,SESSION_IDLE_LOST_AFTER_SECONDS],
  );
  const cardsEnded = await endCardsOfFinishedSessions(db,apnsMode);
  const pruned = await db.query(
    `DELETE FROM agent_sessions WHERE state IN ('ended','lost')
       AND last_event_at<now()-make_interval(days=>$1::int)`,
    [SESSION_RETENTION_DAYS],
  );
  return { lost: lost.rowCount ?? 0,cardsEnded,pruned: pruned.rowCount ?? 0 };
}

async function endCardsOfFinishedSessions(db: Database,apnsMode: ApnsMode): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<any>(
      `SELECT a.*,s.state AS session_state FROM agent_sessions s
       JOIN live_activities a ON a.principal_id=s.principal_id AND a.activity_key=s.card_key
         AND a.state='active' AND a.presentation IS NOT NULL
       WHERE s.card_key IS NOT NULL
         AND (s.state='ended'
           OR (s.state='lost' AND s.ended_at<=now()-make_interval(secs=>$2::double precision)))
         AND a.resume_presentation IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
           WHERE r.state='pending' AND r.expires_at>now() AND e.principal_id=a.principal_id
             AND e.payload#>>'{liveActivity,activityId}'='act_'||a.id::text)
       ORDER BY a.updated_at,a.id FOR UPDATE OF a SKIP LOCKED LIMIT $1`,
      [RECONCILE_BATCH,SESSION_LOST_CARD_GRACE_SECONDS],
    );
    let ended = 0;
    for (const current of due.rows) {
      const lostSession = current.session_state === "lost";
      const stored = terminalPresentationColumnsFromRow(
        current,lostSession ? SESSION_CARD_STATUS_LOST : SESSION_CARD_STATUS_ENDED,"warning");
      const row = (await client.query(
        `UPDATE live_activities SET state='ended',title=$2,status=$3,detail=$4,progress=$5,
           symbol=$6,privacy=$7,accent_color=$8,style=$9,presentation=$10,presentation_sha256=$11,
           terminal_reason=$12,terminal_actor='session',terminal_policy='session_reconciler',
           terminal_transition_at=statement_timestamp(),
           sequence=sequence+1,ended_at=statement_timestamp(),updated_at=statement_timestamp()
         WHERE id=$1 AND state='active' RETURNING *`,
        [current.id,stored.title,stored.status,stored.detail,stored.progress,stored.symbol,
          stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash,
          lostSession ? "session_lost" : "session_ended"],
      )).rows[0];
      if (!row) continue;
      await recordTerminalOperation(client,{
        principalId: row.principal_id,sourceName: "Relo Sessions",activity: row,state: "ended",apnsMode,
      });
      ended += 1;
    }
    await client.query("COMMIT");
    return ended;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
