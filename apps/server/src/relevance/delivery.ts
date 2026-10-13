import { RELEVANCE_DEFAULTS } from "@relo/notification-contracts";

type EventAlias = "e" | "candidate_event";

/** Delivery ceiling for events without relevance metadata: every Live Activity event (they are
 * never admitted as subjects) and nothing else since 0058. Never a new action or history
 * lifetime; uses original event time so recreating a job cannot renew old attention. */
function metadataFreeDeliveryDeadline(event: EventAlias): string {
  return `LEAST(${event}.expires_at,
    (SELECT request.expires_at FROM interaction_requests request WHERE request.notification_event_id=${event}.id),
    COALESCE((SELECT native.deliver_until FROM activity_mutation_freshness native WHERE native.id=${event}.activity_mutation_id),
    ${event}.created_at+(CASE
      WHEN ${event}.payload#>>'{liveActivity,operation}'='end' THEN ${RELEVANCE_DEFAULTS.terminalCleanupSeconds}
      WHEN EXISTS (SELECT 1 FROM interaction_requests request WHERE request.notification_event_id=${event}.id)
        THEN ${RELEVANCE_DEFAULTS.decisionSeconds}
      WHEN ${event}.kind='live_activity' THEN ${RELEVANCE_DEFAULTS.progressDeliverySeconds}
      ELSE ${RELEVANCE_DEFAULTS.noticeDeliverySeconds} END)*interval '1 second'))`;
}

/** Propagate the same absolute ceiling into APNs expiration and provider retry. */
export function relevanceDeliveryDeadline(event: EventAlias): string {
  return `LEAST(${event}.expires_at,COALESCE(
    (SELECT LEAST(nr.deliver_until,nr.action_expires_at,nr.relevant_until,nr.fresh_until)
      FROM notification_relevance nr WHERE nr.notification_event_id=${event}.id),
    ${metadataFreeDeliveryDeadline(event)}))`;
}

/** Shared by admission, claiming, maintenance and the final short authorization.
 * Rows without metadata use bounded windows from original event time.
 * Internal terminal cleanup is deliberately not attached to a current subject:
 * it has its own deadline and continues to target the old native activity. */
export function relevanceDeliveryGuard(event: EventAlias): string {
  return `((NOT EXISTS (SELECT 1 FROM notification_relevance nr WHERE nr.notification_event_id=${event}.id)
      AND ${metadataFreeDeliveryDeadline(event)}>clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM interaction_requests request WHERE request.notification_event_id=${event}.id
        AND (request.state<>'pending' OR request.expires_at<=clock_timestamp())))
    OR EXISTS (SELECT 1 FROM notification_relevance nr
      JOIN relevance_subjects subject ON subject.id=nr.subject_id AND subject.principal_id=${event}.principal_id
      WHERE nr.notification_event_id=${event}.id
        AND subject.generation=nr.generation AND subject.revision=nr.revision
        AND nr.superseded_at IS NULL AND nr.relevance->>'status'='active'
        AND (nr.relevance#>>'{deadlines,kind}'<>'progress' OR ${event}.kind='live_activity')
        AND nr.deliver_until>clock_timestamp()
        AND (nr.action_expires_at IS NULL OR nr.action_expires_at>clock_timestamp())
        AND (nr.relevant_until IS NULL OR nr.relevant_until>clock_timestamp())
        AND (nr.fresh_until IS NULL OR nr.fresh_until>clock_timestamp())))`;
}
