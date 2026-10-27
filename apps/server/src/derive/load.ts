import {
  lastRound,OWNER_STATE_TIMING,PLAN_ROUNDS_WITH_STEPS,planProgressWire,
  type ComputerIcon,
  type PlanDigestRound,
  type PlanDigestStep,
  type PlanProgressWire,
  type OwnerStateInput,
  type ProducerEvidence,
  type WorkPlan,
  type ProducerType,
  type WorkLifecycle,
} from "@relo/notification-contracts";
import type { Database } from "../db.js";
import { loadSessionEvidence,sessionLabelOver } from "../agent-sessions.js";
import { computerLastSeenSql } from "../computers/summary.js";
import { computerIconColumns,iconFromColumns } from "../computers/store.js";
import { leaseEvidence } from "../works/lease.js";
import { askedCopySql } from "../browser-answers.js";
import { PLAN_DIGEST_ROUNDS_MAX } from "../inbox/plan-digest-sql.js";
import { readsAccount,visibilityDeviceId,type DeviceReader } from "../owner-overview.js";

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
  /** The project resource's colour slot (`PROJECT_PALETTE`), when the card names one. */
  projectSlot: number | null;
  producer: ProducerType;
  sessionKey: string | null;
  notificationId: string | null;
  startedAt: Date;
  declaredAt: Date;
  active: boolean;
  /** The work's computer (from its context), for its session row. */
  computer: string | null;
  /** The icon of the computer whose login holds the work (ADR 0011); absent for a work with no computer. */
  computerIcon?: ComputerIcon;
  /** The work is still live (open or paused): only live works give a hookless session a row. */
  workOpen: boolean;
  /** The work's plan as `{done,total,current}` (skipped steps omitted); null without a work or plan. */
  steps: { done: number; total: number; current: string | null } | null;
  /** Plan UX U1, U2: top-level count of the round in play, where the work is, and the labels (readable works only). */
  planProgress: PlanProgressWire | null;
  /** The whole plan with each step's state, parent and round, and the rounds; null without a plan. */
  planDigest: ReturnType<typeof planDigestOf>;
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
  event_id: string | null; source_name: string | null; project: string | null; project_slot: number | null;
  question_id: string | null; question_state: string | null; question_at: Date | null; question_late: boolean | null;
  question_opened_at: Date | null; question_dismissed_at: Date | null; seen_at: Date | null;
  card_sealed: unknown; question_sealed: unknown;
  work_lifecycle: WorkLifecycle | null; work_plan: (Partial<WorkPlan> & { steps?: Array<{ id: string; state: string; label?: string; round?: number }> }) | null;
  work_producer_type: ProducerType | null; work_lease_until: Date | null; work_provider: string | null; work_computer: string | null;
  computer_icon: ComputerIcon | null; computer_kind: string | null; computer_row: boolean; computer_last_seen_at: Date | null;
  work_waiting_since: Date | null; work_declared_at: Date | null; work_finished_at: Date | null; work_sealed_text: boolean | null;
};

/** The plan progress for Now: labels only when the server may read them (not sealed, not a private card). */
export function planProgressOf(row: Row): PlanProgressWire | null {
  if (!row.work_plan?.steps?.length) return null;
  return planProgressWire(row.work_plan as WorkPlan,{
    readable: !row.work_sealed_text && row.privacy !== "private",
    stopped: row.work_lifecycle === "failed" || row.work_lifecycle === "dropped",
  });
}

/**
 * The whole plan for Now, as the inbox activity carries it (inbox/queries.ts): each step's state, parent and round,
 * and the rounds. Labels, details, round titles and outcomes only when the server may read them; devices open the
 * sealed ones by step id. Null without a plan.
 */
export function planDigestOf(row: Row): { plan: PlanDigestStep[]; rounds?: PlanDigestRound[] } | null {
  const steps = row.work_plan?.steps;
  if (!steps?.length) return null;
  const readable = !row.work_sealed_text && row.privacy !== "private";
  const text = (value: unknown,max: number): string | undefined =>
    readable && typeof value === "string" && value.trim() ? Array.from(value).slice(0,max).join("") : undefined;
  // Same rule as the SQL in inbox/plan-digest-sql.ts: steps of the newest rounds only, the newest rounds kept.
  const newest = row.work_plan?.rounds?.reduce((top,round) => Math.max(top,round.n),0) ?? 0;
  const kept = (step: { round?: number | undefined }) => step.round === undefined || step.round >= newest - (PLAN_ROUNDS_WITH_STEPS - 1);
  const plan = steps.filter((step) => ["open","current","done","skipped"].includes(step.state) && kept(step)).slice(-120)
    .map((step): PlanDigestStep => {
      const full = step as WorkPlan["steps"][number];
      const label = text(full.label,120);
      const detail = text(full.detail,200);
      return { id: full.id,state: full.state,label: label ?? null,
        ...(full.parent ? { parent: full.parent } : {}),...(full.round ? { round: full.round } : {}),
        ...(detail ? { detail } : {}),...(full.startedAt ? { startedAt: full.startedAt } : {}),
        ...(full.doneAt ? { doneAt: full.doneAt } : {}),...(full.carriedFrom ? { carriedFrom: full.carriedFrom } : {}) };
    });
  const rounds = row.work_plan?.rounds?.slice(-PLAN_DIGEST_ROUNDS_MAX).map((round): PlanDigestRound => {
    const title = text(round.title,80);
    const outcome = text(round.outcome,200);
    return { n: round.n,state: round.state,...(title ? { title } : {}),...(outcome ? { outcome } : {}),
      ...(round.openedAt ? { openedAt: round.openedAt } : {}),...(round.closedAt ? { closedAt: round.closedAt } : {}) };
  });
  return { plan,...(rounds?.length ? { rounds } : {}) };
}

/**
 * The older `{done,total,current}` Now item field, now the plan wire's own numbers: top-level steps of the round in
 * play, never every step and substep (the phone read "2 of 7" for a plan of four). The label is the top-level step's.
 */
export function stepsOf(row: Row): LoadedWork["steps"] {
  const wire = planProgressOf(row);
  if (!wire || wire.total <= 0) return null;
  return { done: wire.done,total: wire.total,current: wire.stepLabel ?? null };
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
 * Loads the account's visible works (active, terminal within T_history, or carrying a pending
 * question), or the given card ids, as derive() inputs at `now`.
 */
export async function loadOwnerStateInputs(
  db: Pick<Database,"query">,
  principalId: string,
  activityIds: readonly string[] | "visible",
  now: Date,
  reader: DeviceReader = {},
  options: { light?: boolean } = {},
): Promise<LoadedWork[]> {
  // $4 picks the reader's sealed envelopes; $6 bounds the read by a phone's delivery targets (none for
  // the browser or an overview device, whose Now is the whole account's: owner-overview.ts).
  const ids = activityIds === "visible" ? null : activityIds.map((id) => id.replace(/^act_/,""));
  // Island counts need only the last round of a plan (a delivered work), never its steps or labels.
  const plan = options.light
    ? `CASE WHEN w.plan->'steps' IS NOT NULL AND w.plan->'rounds' IS NOT NULL
         THEN jsonb_build_object('steps','[]'::jsonb,'rounds',jsonb_build_array(w.plan->'rounds'->-1)) END`
    : "w.plan";
  // Set-based, one pass each: the cards in play, their newest event, and the questions that name them (no per-card scans).
  const result = await db.query<Row>(
    `WITH cand AS MATERIALIZED (
       SELECT a.id,a.work_id,'act_'||a.id::text AS act FROM live_activities a
       WHERE a.principal_id=$1
         AND ($6::uuid IS NULL OR a.target_device_ids IS NULL OR $6::uuid=ANY(a.target_device_ids))
         AND (CASE WHEN $2::uuid[] IS NOT NULL THEN a.id=ANY($2::uuid[]) ELSE
           -- One item per work: a work that got a new card (paused, then resumed) is its newest card.
           (a.work_id IS NULL OR NOT EXISTS (SELECT 1 FROM live_activities newer WHERE newer.principal_id=a.principal_id
             AND newer.work_id=a.work_id AND (newer.created_at,newer.id)>(a.created_at,a.id))) END)
     ), ev AS MATERIALIZED (
       SELECT DISTINCT ON (e.payload#>>'{liveActivity,activityId}') e.payload#>>'{liveActivity,activityId}' AS act,
         e.id,e.source,left(e.payload#>>'{context,project}',160) AS project_name,e.project_resource_id,
         CASE WHEN $4::uuid IS NOT NULL THEN e.payload->'sealed' END AS sealed
       FROM notification_events e
       WHERE e.principal_id=$1 AND e.kind='live_activity'
         AND e.payload#>>'{liveActivity,activityId}'=ANY(ARRAY(SELECT act FROM cand))
         AND ($6::uuid IS NULL OR e.target_mode='broadcast' OR EXISTS (
           SELECT 1 FROM notification_event_targets t WHERE t.notification_event_id=e.id AND t.device_id=$6))
       ORDER BY e.payload#>>'{liveActivity,activityId}',e.created_at DESC,e.id DESC
     ), qr AS MATERIALIZED (
       SELECT r.id,r.principal_id,r.work_id,r.state,r.created_at,r.late_responded_at,r.owner_dismissed_at,
         qe.payload#>>'{liveActivity,activityId}' AS act,jsonb_build_object('liveActivity',qe.payload->'liveActivity') AS event_payload,
         CASE WHEN $4::uuid IS NOT NULL THEN qe.payload->'sealed' END AS event_sealed
       FROM interaction_requests r JOIN notification_events qe ON qe.id=r.notification_event_id
       WHERE r.principal_id=$1 AND (qe.payload#>>'{liveActivity,activityId}'=ANY(ARRAY(SELECT act FROM cand))
         OR r.work_id=ANY(ARRAY(SELECT work_id FROM cand WHERE work_id IS NOT NULL)))
     )
     SELECT a.id,a.title,a.status,a.privacy,a.state::text AS state,a.producer_type,a.session_key,a.created_at,a.declared_at,
       a.ended_at,a.terminal_transition_at,a.presentation#>>'{state,kind}' AS outcome_kind,
       COALESCE(a.presentation_policy_source LIKE 'system.interactive.%',false) AS question_only,
       a.lifecycle_provider,a.stale_at,
       event.id AS event_id,event.source AS source_name,event.project_name AS project,
       project_resource.palette_ordinal % 12 AS project_slot,
       q.id AS question_id,q.state::text AS question_state,q.created_at AS question_at,
       (q.late_responded_at IS NOT NULL) AS question_late,q.owner_dismissed_at AS question_dismissed_at,
       CASE WHEN $4::uuid IS NOT NULL THEN COALESCE(a.sealed,event.sealed) END AS card_sealed,
       CASE WHEN $4::uuid IS NOT NULL THEN q.event_sealed END AS question_sealed,
       (SELECT max(i.created_at) FROM interactions i WHERE i.interaction_request_id=q.id AND i.kind='opened') AS question_opened_at,
       (SELECT max(i.created_at) FROM interactions i JOIN notification_events oe ON oe.id=i.notification_event_id
         WHERE i.principal_id=a.principal_id AND i.kind='opened'
           AND oe.payload#>>'{liveActivity,activityId}'=cand.act
           AND i.created_at>=COALESCE(a.terminal_transition_at,a.ended_at)) AS seen_at,
       w.lifecycle AS work_lifecycle,${plan} AS work_plan,w.waiting_since AS work_waiting_since,
       w.declared_at AS work_declared_at,w.finished_at AS work_finished_at,w.sealed_text AS work_sealed_text,
       w.producer_type AS work_producer_type,w.lease_until AS work_lease_until,
       left(w.context->>'providerName',200) AS work_provider,left(w.context->>'computer',120) AS work_computer,
       ${computerIconColumns("c")},c.id IS NOT NULL AS computer_row,
       ${computerLastSeenSql("c")} AS computer_last_seen_at
     FROM cand
     JOIN live_activities a ON a.id=cand.id
     LEFT JOIN works w ON w.id=a.work_id AND w.principal_id=a.principal_id
     LEFT JOIN computers c ON c.login_key_id=w.credential_id AND c.principal_id=w.principal_id
     LEFT JOIN ev event ON event.act=cand.act
     LEFT JOIN resource_projects project_resource ON project_resource.principal_id=a.principal_id
       AND project_resource.id=COALESCE(a.project_resource_id,event.project_resource_id)
     LEFT JOIN LATERAL (
       SELECT r.* FROM qr r, LATERAL (SELECT r.event_payload AS payload) qe
       WHERE r.act=cand.act OR (a.work_id IS NOT NULL AND r.work_id=a.work_id)
       -- An overview device answers the copy the asker waits on, so its Now names that copy.
       ORDER BY r.created_at DESC,CASE WHEN $7::boolean THEN r.id=${askedCopySql("r","qe")} END DESC NULLS LAST,r.id DESC LIMIT 1
     ) q ON true
     WHERE (CASE WHEN $2::uuid[] IS NOT NULL THEN true ELSE (
         a.state='active' OR a.state='expired' AND a.declared_at>$3::timestamptz-make_interval(secs=>$5::double precision)
         OR COALESCE(a.terminal_transition_at,a.ended_at)>$3::timestamptz-make_interval(secs=>$5::double precision)
         OR q.state='pending') END)
     ORDER BY a.declared_at DESC,a.id DESC LIMIT ${VISIBLE_LIMIT}`,
    // Expired rows are open works for derive(); they stay visible until left unfinished leaves Now (2 × T_history).
    [principalId,ids,now,reader.deviceId ?? null,OWNER_STATE_TIMING.historySeconds * 2,visibilityDeviceId(reader) ?? null,
      readsAccount(reader)],
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
          openToolSince: session.openToolSince ? new Date(session.openToolSince).toISOString() : null,
          ...(session.heartbeatAt ? { heartbeatAt: new Date(session.heartbeatAt).toISOString() } : {}) } : null,
        ...(row.computer_last_seen_at ? { computerLastSeenAt: row.computer_last_seen_at.toISOString() } : {}) }
      : (row.work_producer_type ? leaseEvidence({ producer_type: row.work_producer_type,lifecycle,lease_until: row.work_lease_until }) : null)
        ?? { producer: row.producer_type,leaseUntil: row.lifecycle_provider && row.stale_at ? row.stale_at.toISOString() : null };
    const privateCard = row.privacy === "private";
    // A delivered work (open, last round closed): the round's close time, or its last declared write.
    const closedRound = row.work_lifecycle === "open" && row.work_plan?.steps && row.work_plan.rounds
      ? lastRound(row.work_plan as WorkPlan) : null;
    const roundClosedAt = closedRound?.state === "closed" ? closedRound.closedAt ?? declaredAt.toISOString() : null;
    return {
      id: `act_${row.id}`,
      title: privateCard ? "Private activity" : row.title.slice(0,200),
      status: privateCard || row.status === null ? null : row.status.slice(0,160),
      sourceName: (row.source_name ?? row.work_provider)?.slice(0,200) ?? null,
      // A session's own labels (hooks) win over the card's copy, so Now and Sessions name the same computer and project.
      computer: privateCard ? null : sessionLabelOver(session?.computer,row.work_computer),
      ...(row.computer_row ? { computerIcon: iconFromColumns(row.computer_icon,row.computer_kind).icon } : {}),
      workOpen: row.work_lifecycle ? row.work_lifecycle === "open" || row.work_lifecycle === "paused" : row.state === "active",
      project: privateCard ? null : sessionLabelOver(session?.project,row.project),
      projectSlot: privateCard || row.project_slot === null ? null : Number(row.project_slot),
      producer: row.producer_type,
      sessionKey: row.session_key,
      notificationId: row.event_id ? `ntf_${row.event_id}` : null,
      startedAt: row.created_at,
      declaredAt,
      active: row.state === "active",
      steps: stepsOf(row),
      planProgress: planProgressOf(row),
      planDigest: planDigestOf(row),
      question,
      sealed: reader.deviceId === undefined ? null : { card: privateCard ? null : row.card_sealed,question: row.question_sealed },
      input: {
        now: now.toISOString(),
        work: {
          lifecycle,
          startedAt: row.created_at.toISOString(),
          lastDeclaredAt: declaredAt.toISOString(),
          finishedAt: finished ? finished.toISOString() : null,
          waitingSince: row.work_waiting_since ? row.work_waiting_since.toISOString() : null,
          seenAt: row.seen_at ? row.seen_at.toISOString() : null,
          ...(roundClosedAt ? { roundClosedAt } : {}),
        },
        question: question ? { standing: question.standing,askedAt: question.askedAt.toISOString(),
          openedAt: question.openedAt ? question.openedAt.toISOString() : null,
          ...(question.dismissedAt ? { dismissedAt: question.dismissedAt.toISOString() } : {}) } : null,
        evidence,
      },
    };
  });
}
