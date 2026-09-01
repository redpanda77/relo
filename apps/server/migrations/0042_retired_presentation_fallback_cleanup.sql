-- A 0.7.27 deployment may already have retained V3 rows authored before the
-- current contract removed its compatibility fallback object. Those rows are
-- not valid current presentations. This development cutover deletes them and
-- their activity-only evidence rather than carrying another runtime decoder.
CREATE TEMP TABLE retired_fallback_activity_ids ON COMMIT DROP AS
SELECT id
FROM live_activities
WHERE presentation ? 'fallback';

ALTER TABLE delivery_attempts DISABLE TRIGGER delivery_attempts_no_delete;
ALTER TABLE notification_withdrawal_evidence DISABLE TRIGGER notification_withdrawal_evidence_no_delete;
ALTER TABLE activity_correlation_decisions DISABLE TRIGGER activity_correlation_decisions_no_delete;
ALTER TABLE activity_relationships DISABLE TRIGGER activity_relationships_no_delete;

DELETE FROM notification_events event
WHERE event.kind='live_activity'
  AND (
    event.payload::text LIKE '%"fallback"%'
    OR event.payload#>>'{liveActivity,activityId}' IN (
      SELECT 'act_' || id::text FROM retired_fallback_activity_ids
    )
  );

DELETE FROM live_activities activity
USING retired_fallback_activity_ids retired
WHERE activity.id=retired.id;

DELETE FROM live_activity_operations
WHERE presentation_snapshot ? 'fallback';

ALTER TABLE delivery_attempts ENABLE TRIGGER delivery_attempts_no_delete;
ALTER TABLE notification_withdrawal_evidence ENABLE TRIGGER notification_withdrawal_evidence_no_delete;
ALTER TABLE activity_correlation_decisions ENABLE TRIGGER activity_correlation_decisions_no_delete;
ALTER TABLE activity_relationships ENABLE TRIGGER activity_relationships_no_delete;

ALTER TABLE live_activities
  ADD CONSTRAINT live_activities_no_retired_fallback_check CHECK (
    NOT (presentation ? 'fallback')
  );

ALTER TABLE live_activity_operations
  ADD CONSTRAINT live_activity_operations_no_retired_fallback_check CHECK (
    NOT (presentation_snapshot ? 'fallback')
  );
