import { publicId } from "../ids.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };

export type QuestionOutcome = {
  state: "approved" | "denied" | "yes" | "no" | "replied" | "expired" | "canceled";
  /** The answer to copy onto every copy. Omitted: the winning copy's own stored response. */
  response?: Record<string, unknown> | null;
};

export type SettledCopy = { id: string; principalId: string; notificationEventId: string };

const ANSWERS = ["approved","denied","yes","no","replied"];
const EVENT_STATE = { expired: "expired",canceled: "canceled" } as const;

/**
 * The one place a question's other copies are settled. A question can exist as several copies (an
 * interaction_requests row and a notification_events row per phone); when one copy is answered,
 * expires or is canceled, every other pending copy takes the same outcome: request state, response,
 * the copy that was answered (docs/ENCRYPTION-PROTOCOL.md, "Answers on another copy"), the
 * notification's state, its relevance, and its unsent delivery jobs.
 *
 * `scope` finds the copies: every pending request of a card's activity, or of a decision group.
 * `winner` is the copy that already settled (excluded; its response is the default for the others).
 * `deadline` matters for expiry only: "shared" copies were made together with one deadline, so the
 * first copy's expiry closes all; "own" copies expire only once their own deadline has passed.
 * `beforeSettle` lets a caller take its own lock on a copy first (the caller keeps its locking).
 */
export async function settleQuestionCopies(query: Queryable,input: {
  scope: { activity: { principalId: string; activityId: string } } | { decisionGroupId: string };
  winner?: { interactionId?: string; notificationEventId?: string; principalId?: string } | undefined;
  outcome: QuestionOutcome;
  deadline?: "shared" | "own";
  beforeSettle?: (copy: SettledCopy) => Promise<void>;
}): Promise<SettledCopy[]> {
  const { outcome } = input;
  const winnerRow = input.winner ? (await query.query(
    `SELECT id,response,COALESCE(answered_on_request_id,id) AS answered FROM interaction_requests
     WHERE ($1::uuid IS NULL OR id=$1) AND ($2::uuid IS NULL OR notification_event_id=$2)
       AND ($3::uuid IS NULL OR principal_id=$3)`,
    [input.winner.interactionId ?? null,input.winner.notificationEventId ?? null,input.winner.principalId ?? null],
  )).rows[0] : undefined;
  const ownDeadlineOnly = outcome.state === "expired" && (input.deadline ?? "own") === "own";
  const answered = ANSWERS.includes(outcome.state) ? winnerRow?.answered ?? null : null;
  const response = outcome.response !== undefined ? outcome.response : winnerRow?.response ?? null;
  const candidates: Array<{ id: string; principal_id: string; notification_event_id: string }> = "activity" in input.scope
    ? (await query.query(
      `SELECT r.id,r.principal_id,r.notification_event_id FROM interaction_requests r
       JOIN notification_events e ON e.id=r.notification_event_id
       WHERE r.state='pending' AND e.principal_id=$1 AND e.payload#>>'{liveActivity,activityId}'=$2
         AND r.id IS DISTINCT FROM $3 ORDER BY r.id`,
      [input.scope.activity.principalId,publicId("act",input.scope.activity.activityId),winnerRow?.id ?? null],
    )).rows
    : (await query.query(
      `SELECT id,principal_id,notification_event_id FROM interaction_requests
       WHERE decision_group_id=$1 AND state='pending' AND id IS DISTINCT FROM $2 ORDER BY id`,
      [input.scope.decisionGroupId,winnerRow?.id ?? null],
    )).rows;
  const settled: SettledCopy[] = [];
  for (const candidate of candidates) {
    const copy = { id: candidate.id,principalId: candidate.principal_id,notificationEventId: candidate.notification_event_id };
    await input.beforeSettle?.(copy);
    const taken = await query.query(
      `UPDATE interaction_requests r SET state=$2::interaction_request_state,response=$3::jsonb,
         responded_at=clock_timestamp(),answered_on_request_id=NULLIF($4::uuid,r.id)
       WHERE r.id=$1 AND r.state='pending' AND ($5::boolean IS FALSE OR r.expires_at<=clock_timestamp())
       RETURNING r.id`,
      [copy.id,outcome.state,response,answered,ownDeadlineOnly],
    );
    if (!taken.rowCount) continue;
    await query.query(
      `UPDATE notification_events SET state=$2::notification_state,updated_at=clock_timestamp()
       WHERE id=$1 AND state='active'`,
      [copy.notificationEventId,outcome.state in EVENT_STATE ? EVENT_STATE[outcome.state as keyof typeof EVENT_STATE] : "responded"],
    );
    await query.query(
      `UPDATE notification_relevance SET relevance=jsonb_set(relevance,'{status}','"settled"'::jsonb)
       WHERE notification_event_id=$1 AND superseded_at IS NULL`,[copy.notificationEventId]);
    await query.query(
      `UPDATE delivery_jobs SET state='canceled',last_error_code='interaction_settled',
         last_error_message=$2,claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,
         lease_expires_at=NULL,updated_at=clock_timestamp()
       WHERE notification_event_id=$1 AND (state IN ('pending','retry')
         OR (state='processing' AND claim_phase='preparing'))`,
      [copy.notificationEventId,outcome.state === "canceled" ? "The question was canceled" : "The question was settled on another phone"]);
    settled.push(copy);
  }
  return settled;
}
