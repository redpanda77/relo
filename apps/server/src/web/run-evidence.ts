/**
 * Phone evidence for a Live Activity run, as a lateral join over the run row `a`: the phones the
 * run was sent to, and how many of them reported anything back for it (a receipt, an open, or an
 * answer). Live Activity starts, updates and ends never wake the app, so a phone's answer is often
 * its only report, and it proves that phone had the card.
 */
export const RUN_PHONE_EVIDENCE_SQL = `LEFT JOIN LATERAL (
  SELECT count(DISTINCT t.device_id)::int AS expected,
    count(DISTINCT t.device_id) FILTER (WHERE EXISTS (
      SELECT 1 FROM interactions i JOIN notification_events reported ON reported.id=i.notification_event_id
      WHERE i.device_id=t.device_id AND reported.principal_id=a.principal_id
        AND reported.payload#>>'{liveActivity,activityId}'='act_'||a.id::text))::int AS confirmed
  FROM notification_events e
  JOIN notification_event_targets t ON t.notification_event_id=e.id
  WHERE e.principal_id=a.principal_id
    AND e.payload#>>'{liveActivity,activityId}'='act_'||a.id::text
) run_receipts ON true`;

/** When a phone first showed the run's card (from `live_activity_phone_evidence`), as `run_card`. */
export const RUN_CARD_EVIDENCE_SQL = `LEFT JOIN LATERAL (
  SELECT min(shown.shown_at) AS shown_at FROM live_activity_phone_evidence shown
  WHERE shown.live_activity_id=a.id
) run_card ON true`;

/** The Test Lab's "Live Activity" step: reported only once a phone actually showed the card. */
export function cardEvidence(shownAt: unknown): { state: string | null; summary: string | null } {
  return shownAt ? { state: "received",summary: "Shown on the iPhone" } : { state: null,summary: null };
}
