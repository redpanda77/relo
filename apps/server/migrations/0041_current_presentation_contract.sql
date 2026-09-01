-- Pre-public cleanup: discard activity history created under obsolete presentation
-- contracts. There is intentionally no conversion or runtime compatibility path.
CREATE TEMP TABLE stale_live_activity_ids ON COMMIT DROP AS
SELECT id
FROM live_activities
WHERE presentation IS NULL
  OR presentation->>'version' IS DISTINCT FROM '3'
  OR presentation ? 'fallback'
  OR presentation @? '$.components[*] ? (@.type == "progress_ring")';

-- Notification events reference public activity IDs inside JSON rather than through a
-- foreign key, so remove both obsolete events and current-version events attached to
-- an obsolete activity before the activity rows are deleted.
-- Delivery attempts are normally append-only. This one pre-public reset deliberately
-- removes only attempts that cascade from obsolete presentation events, then restores
-- the invariant in the same migration transaction.
ALTER TABLE delivery_attempts DISABLE TRIGGER delivery_attempts_no_delete;
ALTER TABLE notification_withdrawal_evidence DISABLE TRIGGER notification_withdrawal_evidence_no_delete;
ALTER TABLE activity_correlation_decisions DISABLE TRIGGER activity_correlation_decisions_no_delete;
ALTER TABLE activity_relationships DISABLE TRIGGER activity_relationships_no_delete;

DELETE FROM notification_events event
WHERE event.kind='live_activity'
  AND (
    COALESCE(event.payload#>>'{liveActivity,presentationVersion}','') <> '3'
    OR event.payload::text LIKE '%"fallback"%'
    OR event.payload::text LIKE '%progress_ring%'
    OR event.payload#>>'{liveActivity,activityId}' IN (
      SELECT 'act_' || id::text FROM stale_live_activity_ids
    )
  );

DELETE FROM live_activities activity
USING stale_live_activity_ids stale
WHERE activity.id=stale.id;

DELETE FROM live_activity_operations
WHERE presentation_snapshot @? '$.components[*] ? (@.type == "progress_ring")';

ALTER TABLE delivery_attempts ENABLE TRIGGER delivery_attempts_no_delete;
ALTER TABLE notification_withdrawal_evidence ENABLE TRIGGER notification_withdrawal_evidence_no_delete;
ALTER TABLE activity_correlation_decisions ENABLE TRIGGER activity_correlation_decisions_no_delete;
ALTER TABLE activity_relationships ENABLE TRIGGER activity_relationships_no_delete;

ALTER TABLE live_activities
  ALTER COLUMN presentation SET NOT NULL,
  ALTER COLUMN presentation_policy SET NOT NULL,
  ALTER COLUMN presentation_policy_source SET NOT NULL,
  ALTER COLUMN presentation_preset_id SET NOT NULL,
  ALTER COLUMN presentation_preset_revision SET NOT NULL,
  DROP CONSTRAINT live_activities_presentation_version_check,
  ADD CONSTRAINT live_activities_presentation_version_check CHECK (
    jsonb_typeof(presentation)='object'
    AND presentation->>'version'='3'
    AND NOT (presentation @? '$.components[*] ? (@.type == "progress_ring")')
    AND octet_length(presentation::text)<=4096
  );

ALTER TABLE live_activity_operations
  ALTER COLUMN presentation_snapshot SET NOT NULL,
  DROP CONSTRAINT live_activity_operations_presentation_version_check,
  ADD CONSTRAINT live_activity_operations_presentation_version_check CHECK (
    jsonb_typeof(presentation_snapshot)='object'
    AND presentation_snapshot->>'version'='3'
    AND NOT (presentation_snapshot @? '$.components[*] ? (@.type == "progress_ring")')
    AND octet_length(presentation_snapshot::text)<=4096
  );

COMMENT ON COLUMN live_activities.presentation IS
  'Required current canonical private-projected presentation JSON.';
COMMENT ON COLUMN live_activity_operations.presentation_snapshot IS
  'Required current canonical presentation captured with the immutable operation snapshot.';
