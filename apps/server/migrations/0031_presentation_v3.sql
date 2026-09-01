ALTER TABLE live_activities
  DROP CONSTRAINT live_activities_presentation_v2_check,
  ADD CONSTRAINT live_activities_presentation_version_check CHECK (
    presentation IS NULL OR (
      jsonb_typeof(presentation)='object'
      AND presentation->>'version' IN ('2','3')
      AND octet_length(presentation::text)<=4096
    )
  );

ALTER TABLE live_activity_operations
  DROP CONSTRAINT live_activity_operations_presentation_v2_check,
  ADD CONSTRAINT live_activity_operations_presentation_version_check CHECK (
    presentation_snapshot IS NULL OR (
      jsonb_typeof(presentation_snapshot)='object'
      AND presentation_snapshot->>'version' IN ('2','3')
      AND octet_length(presentation_snapshot::text)<=4096
    )
  );

COMMENT ON COLUMN live_activities.presentation IS
  'Canonical private-projected Presentation V2 or V3 JSON. NULL identifies a legacy row pending application normalization.';
COMMENT ON COLUMN live_activity_operations.presentation_snapshot IS
  'Canonical Presentation V2 or V3 value captured with the immutable operation snapshot.';
