-- Current operational state is not prunable history. Preserve the existing
-- retention ACL/transaction owner and add canonical heads to its protections.
-- Freshness alone does not retire progress: stale current work remains visible.
CREATE OR REPLACE VIEW notification_retention_eligibility AS
WITH ranked AS (
  SELECT event.id,
    row_number() OVER (
      PARTITION BY event.principal_id
      ORDER BY event.created_at DESC,event.id DESC
    )::integer AS history_rank
  FROM notification_events event
)
SELECT event.id,event.principal_id,event.created_at,ranked.history_rank,
  NOT EXISTS (
    SELECT 1 FROM delivery_jobs job
    WHERE job.notification_event_id=event.id
      AND job.state IN ('pending','processing','retry','reconciliation_required')
  )
  AND NOT EXISTS (
    SELECT 1 FROM interaction_requests request
    WHERE request.notification_event_id=event.id AND request.state='pending'
  )
  AND NOT EXISTS (
    SELECT 1 FROM live_activities activity
    WHERE activity.principal_id=event.principal_id AND activity.state='active'
      AND event.payload#>>'{liveActivity,activityId}'='act_'||activity.id::text
  )
  AND NOT EXISTS (
    SELECT 1 FROM relevance_subjects subject
    JOIN notification_relevance relevance ON relevance.notification_event_id=subject.current_event_id
      AND relevance.subject_id=subject.id AND relevance.generation=subject.generation
      AND relevance.revision=subject.revision
    WHERE subject.principal_id=event.principal_id AND subject.current_event_id=event.id
      AND event.state='active' AND event.withdrawn_at IS NULL
      AND relevance.superseded_at IS NULL AND relevance.relevance->>'status'='active'
      AND (LEAST(event.expires_at,relevance.action_expires_at,relevance.relevant_until) IS NULL
        OR LEAST(event.expires_at,relevance.action_expires_at,relevance.relevant_until)>now())
  ) AS terminal_eligible
FROM notification_events event
JOIN ranked ON ranked.id=event.id;
