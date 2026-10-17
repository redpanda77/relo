import type { Database } from "./db.js";

/**
 * Read-only measures over the observed transition log (agent_session_transitions), for the lifecycle
 * plan's baselines. They read the log only: nothing here writes, derives a phase or touches a card.
 * A route may expose them to `relo admin` later.
 */

/** A wait shorter than this is a quick quit, not a false alarm. */
export const FALSE_NEEDS_YOU_MIN_SECONDS = 120;

/**
 * False "Needs you" in the last 7 days: a session that went `waiting` and then `ended` with no
 * `working` in between, the wait lasting more than 2 minutes. `principalId` limits it to one account.
 */
export async function falseNeedsYouPerWeek(db: Pick<Database,"query">,principalId?: string): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::int AS n FROM (
       SELECT t.new_phase,t.recorded_at,t.phase_since,s.principal_id,
         lag(t.new_phase) OVER w AS before_phase,lag(t.phase_since) OVER w AS before_since
       FROM agent_session_transitions t JOIN agent_sessions s ON s.id=t.session_id
       WINDOW w AS (PARTITION BY t.session_id ORDER BY t.phase_since,t.id)
     ) x
     WHERE x.new_phase='ended' AND x.before_phase='waiting'
       AND extract(epoch FROM x.phase_since-x.before_since)>$1
       AND x.recorded_at>now()-interval '7 days'
       AND ($2::uuid IS NULL OR x.principal_id=$2::uuid)`,
    [FALSE_NEEDS_YOU_MIN_SECONDS,principalId ?? null],
  );
  return result.rows[0].n;
}

export type EndedSessionClear = {
  sessionId: string;
  endReason: "hook" | "gone" | "mcp" | null;
  endedAt: string;
  /** Seconds from the session's last sign of life to its end. */
  seconds: number;
};

/** For each session that ended in the last 7 days: the gap between its last sign of life (`last_seen_at` before the end) and the end. */
export async function timeToClearEndedSessions(db: Pick<Database,"query">,principalId?: string): Promise<EndedSessionClear[]> {
  const result = await db.query(
    `SELECT x.session_id,x.end_reason,x.phase_since AS ended_at,round(extract(epoch FROM x.phase_since-x.previous_last_seen_at))::float8 AS seconds FROM (
       SELECT t.session_id,t.new_phase,t.end_reason,t.recorded_at,t.phase_since,t.previous_last_seen_at,s.principal_id,
         lag(t.new_phase) OVER w AS before_phase,lag(t.phase_since) OVER w AS before_since
       FROM agent_session_transitions t JOIN agent_sessions s ON s.id=t.session_id
       WINDOW w AS (PARTITION BY t.session_id ORDER BY t.phase_since,t.id)
     ) x
     WHERE x.new_phase='ended' AND x.before_phase IS NOT NULL AND x.before_phase<>'ended' AND x.previous_last_seen_at IS NOT NULL
       AND x.recorded_at>now()-interval '7 days'
       AND ($1::uuid IS NULL OR x.principal_id=$1::uuid)
     ORDER BY x.phase_since DESC`,
    [principalId ?? null],
  );
  return result.rows.map((row: any) => ({ sessionId: row.session_id,endReason: row.end_reason,
    endedAt: new Date(row.ended_at).toISOString(),seconds: row.seconds }));
}
