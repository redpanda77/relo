import {
  OWNER_STATE_TIMING,
  type OwnerStateInput,
  type ProducerEvidence,
  type ProducerType,
  type WorkLifecycle,
} from "@relo/notification-contracts";
import type { Database } from "../db.js";
import { loadSessionEvidence } from "../agent-sessions.js";
import { leaseEvidence } from "../works/lease.js";

/**
 * The owner-state loader (spec 8 "derive() on today's rows"): the one place that turns card rows
 * into derive() inputs, with typed evidence per producer type. Reads only; never writes.
 */
export type LoadedWork = {
  id: string;
  title: string;
  status: string | null;
  sourceName: string | null;
  project: string | null;
  producer: ProducerType;
  sessionKey: string | null;
  notificationId: string | null;
  startedAt: Date;
  declaredAt: Date;
  active: boolean;
  /** The work's computer (from its context), for its session row. */
  computer: string | null;
  /** The work is still live (open or paused): only live works give a hookless session a row. */
  workOpen: boolean;
  /** The work's plan as `{done,total,current}` (skipped steps omitted); null without a work or plan. */
  steps: { done: number; total: number; current: string | null } | null;
  question: { id: string; standing: "pending" | "missed" | "answered" | "answered_late"; askedAt: Date; openedAt: Date | null;
    dismissedAt: Date | null } | null;
  /**
   * Stored end-to-end envelopes, loaded only for a phone (`deviceId` given), never otherwise: the
   * card's sealed text (none for a private card) and its question event's sealed text, as stored.
   */
  sealed: { card: unknown; question: unknown } | null;
  input: OwnerStateInput;
};

const VISIBLE_LIMIT = 500;

type Row = {
  id: string; title: string; status: string | null; privacy: string; state: string; producer_type: ProducerType;
  session_key: string | null; created_at: Date; declared_at: Date; ended_at: Date | null; terminal_transition_at: Date | null;
  outcome_kind: string | null; question_only: boolean; lifecycle_provider: string | null; stale_at: Date | null;
  event_id: string | null; source_name: string | null; project: string | null;
  question_id: string | null; question_state: string | null; question_at: Date | null; question_late: boolean | null;
  question_opened_at: Date | null; question_dismissed_at: Date | null; seen_at: Date | null;
  card_sealed: unknown; question_sealed: unknown;
  work_lifecycle: WorkLifecycle | null; work_plan: { steps?: Array<{ id: string; state: string; label?: string }> } | null;
  work_producer_type: ProducerType | null; work_lease_until: Date | null; work_provider: string | null; work_computer: string | null;
  work_waiting_since: Date | null; work_declared_at: Date | null; work_finished_at: Date | null; work_sealed_text: boolean | null;
};

/** A work's plan for Now: visible steps counted, the current step's label (never for sealed text). */
function stepsOf(row: Row): LoadedWork["steps"] {
  const visible = (row.work_plan?.steps ?? []).filter((step) => step.state !== "skipped");
  if (!visible.length) return null;
  const current = visible.find((step) => step.state === "current");
  return {
    done: visible.filter((step) => step.state === "done").length,
    total: visible.length,
    current: current && !row.work_sealed_text && row.privacy !== "private"
      ? (current.label ?? `Step ${current.id.replace(/^s/,"")}`).slice(0,80) : null,
  };
}

function lifecycleOf(row: Row): WorkLifecycle {
  // A card that is a view of a work: the work's declared lifecycle is the truth (2.1d).
  if (row.work_lifecycle) return row.work_lifecycle;
  if (row.question_only) return row.state === "active" ? "open" : "dropped";
  switch (row.state) {
    case "active": return "open";
    case "replaced": return "dropped";
    // A server expiry was never a declared outcome: derive turns it into no signal / left unfinished.
    case "expired": return "open";
    default: return row.outcome_kind === "failed" ? "failed" : "finished";
  }
}

function questionOf(row: Row): LoadedWork["question"] {
  if (!row.question_id || !row.question_state || !row.question_at) return null;
  const standing = row.question_state === "pending" ? "pending"
    : row.question_state === "expired" ? (row.question_late ? "answered_late" : "missed")
      : row.question_state === "canceled" ? null : "answered";
  if (!standing) return null;
  return { id: `int_${row.question_id}`,standing,askedAt: row.question_at,openedAt: row.question_opened_at,
    dismissedAt: standing === "missed" ? row.question_dismissed_at : null };
}

/**
 * Loads the account's visible works (active, terminal within T_history, or carrying a pending or
 * unopened missed question), or the given card ids, as derive() inputs at `now`.
 */
export async function loadOwnerStateInputs(
  db: Pick<Database,"query">,
  principalId: string,
  activityIds: readonly string[] | "visible",
  now: Date,
  deviceId?: string,
): Promise<LoadedWork[]> {
  const ids = activityIds === "visible" ? null : activityIds.map((id) => id.replace(/^act_/,""));
  const result = await db.query<Row>(
    `SELECT a.id,a.title,a.status,a.privacy,a.state::text AS state,a.producer_type,a.session_key,a.created_at,a.declared_at,
       a.ended_at,a.terminal_transition_at,a.presentation#>>'{state,kind}' AS outcome_kind,
       COALESCE(a.presentation_policy_source LIKE 'system.interactive.%',false) AS question_only,
       a.lifecycle_provider,a.stale_at,
       event.id AS event_id,event.source AS source_name,left(event.payload#>>'{context,project}',160) AS project,
       q.id AS question_id,q.state::text AS question_state,q.created_at AS question_at,
       (q.late_responded_at IS NOT NULL) AS question_late,q.owner_dismissed_at AS question_dismissed_at,
       CASE WHEN $4::uuid IS NOT NULL THEN COALESCE(a.sealed,event.payload->'sealed') END AS card_sealed,
       CASE WHEN $4::uuid IS NOT NULL THEN q.event_sealed END AS question_sealed,
       (SELECT max(i.created_at) FROM interactions i WHERE i.interaction_request_id=q.id AND i.kind='opened') AS question_opened_at,
       (SELECT max(i.created_at) FROM interactions i JOIN notification_events oe ON oe.id=i.notification_event_id
         WHERE i.principal_id=a.principal_id AND i.kind='opened'
           AND oe.payload#>>'{liveActivity,activityId}'='act_'||a.id::text
           AND i.created_at>=COALESCE(a.terminal_transition_at,a.ended_at)) AS seen_at,
       w.lifecycle AS work_lifecycle,w.plan AS work_plan,w.waiting_since AS work_waiting_since,
       w.declared_at AS work_declared_at,w.finished_at AS work_finished_at,w.sealed_text AS work_sealed_text,
       w.producer_type AS work_producer_type,w.lease_until AS work_lease_until,
       left(w.context->>'providerName',200) AS work_provider,left(w.context->>'computer',120) AS work_computer
     FROM live_activities a
     LEFT JOIN works w ON w.id=a.work_id AND w.principal_id=a.principal_id
     LEFT JOIN LATERAL (
       SELECT e.id,e.source,e.payload FROM notification_events e
       WHERE e.principal_id=a.principal_id AND e.kind='live_activity'
         AND e.payload#>>'{liveActivity,activityId}'='act_'||a.id::text
         AND ($4::uuid IS NULL OR e.target_mode='broadcast' OR EXISTS (
           SELECT 1 FROM notification_event_targets t WHERE t.notification_event_id=e.id AND t.device_id=$4))
       ORDER BY e.created_at DESC,e.id DESC LIMIT 1
     ) event ON true
     LEFT JOIN LATERAL (
       SELECT r.*,qe.payload->'sealed' AS event_sealed FROM interaction_requests r JOIN notification_events qe ON qe.id=r.notification_event_id
       WHERE r.principal_id=a.principal_id AND (qe.payload#>>'{liveActivity,activityId}'='act_'||a.id::text
         OR (a.work_id IS NOT NULL AND r.work_id=a.work_id))
       ORDER BY r.created_at DESC,r.id DESC LIMIT 1
     ) q ON true
     WHERE a.principal_id=$1
       AND ($4::uuid IS NULL OR a.target_device_ids IS NULL OR $4::uuid=ANY(a.target_device_ids))
       AND (CASE WHEN $2::uuid[] IS NOT NULL THEN a.id=ANY($2::uuid[]) ELSE (
         a.state='active' OR a.state='expired' AND a.declared_at>$3::timestamptz-make_interval(secs=>$5::double precision)
         OR COALESCE(a.terminal_transition_at,a.ended_at)>$3::timestamptz-make_interval(secs=>$5::double precision)
         OR q.state='pending'
         OR q.state='expired' AND q.late_responded_at IS NULL AND q.owner_dismissed_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM interactions i WHERE i.interaction_request_id=q.id AND i.kind='opened')) END)
     ORDER BY a.declared_at DESC,a.id DESC LIMIT ${VISIBLE_LIMIT}`,
    // Expired rows are open works for derive(); they stay visible until left unfinished leaves Now (2 × T_history).
    [principalId,ids,now,deviceId ?? null,OWNER_STATE_TIMING.historySeconds * 2],
  );
  const keys = result.rows.flatMap((row) => row.producer_type === "agent_session" && row.session_key ? [row.session_key] : []);
  const sessions = await loadSessionEvidence(db,principalId,keys);
  return result.rows.map((row): LoadedWork => {
    const lifecycle = lifecycleOf(row);
    const question = questionOf(row);
    const finished = lifecycle === "open" || lifecycle === "paused" ? null
      : row.work_finished_at ?? row.terminal_transition_at ?? row.ended_at ?? row.declared_at;
    const declaredAt = row.work_declared_at && row.work_declared_at > row.declared_at ? row.work_declared_at : row.declared_at;
    const session = row.session_key ? sessions.get(row.session_key) : undefined;
    const evidence: ProducerEvidence = row.producer_type === "agent_session"
      ? { producer: "agent_session",session: session
        ? { phase: session.phase,phaseSince: new Date(session.phaseSince).toISOString(),
          lastSeenAt: new Date(session.lastSeenAt).toISOString(),
          openToolSince: session.openToolSince ? new Date(session.openToolSince).toISOString() : null } : null }
      : (row.work_producer_type ? leaseEvidence({ producer_type: row.work_producer_type,lifecycle,lease_until: row.work_lease_until }) : null)
        ?? { producer: row.producer_type,leaseUntil: row.lifecycle_provider && row.stale_at ? row.stale_at.toISOString() : null };
    const privateCard = row.privacy === "private";
    return {
      id: `act_${row.id}`,
      title: privateCard ? "Private activity" : row.title.slice(0,200),
      status: privateCard || row.status === null ? null : row.status.slice(0,160),
      sourceName: (row.source_name ?? row.work_provider)?.slice(0,200) ?? null,
      computer: privateCard ? null : row.work_computer,
      workOpen: row.work_lifecycle ? row.work_lifecycle === "open" || row.work_lifecycle === "paused" : row.state === "active",
      project: privateCard ? null : row.project,
      producer: row.producer_type,
      sessionKey: row.session_key,
      notificationId: row.event_id ? `ntf_${row.event_id}` : null,
      startedAt: row.created_at,
      declaredAt,
      active: row.state === "active",
      steps: stepsOf(row),
      question,
      sealed: deviceId === undefined ? null : { card: privateCard ? null : row.card_sealed,question: row.question_sealed },
      input: {
        now: now.toISOString(),
        work: {
          lifecycle,
          startedAt: row.created_at.toISOString(),
          lastDeclaredAt: declaredAt.toISOString(),
          finishedAt: finished ? finished.toISOString() : null,
          waitingSince: row.work_waiting_since ? row.work_waiting_since.toISOString() : null,
          seenAt: row.seen_at ? row.seen_at.toISOString() : null,
        },
        question: question ? { standing: question.standing,askedAt: question.askedAt.toISOString(),
          openedAt: question.openedAt ? question.openedAt.toISOString() : null,
          ...(question.dismissedAt ? { dismissedAt: question.dismissedAt.toISOString() } : {}) } : null,
        evidence,
      },
    };
  });
}
