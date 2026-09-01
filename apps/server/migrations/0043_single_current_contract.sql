-- Relo is pre-release and has one server plus one iOS consumer. Retire every
-- device registration and Live Activity created under an older wire shape.
-- There is deliberately no decoder, downgrade, or data-conversion path.
ALTER TABLE delivery_attempts DISABLE TRIGGER delivery_attempts_no_delete;
ALTER TABLE notification_withdrawal_evidence DISABLE TRIGGER notification_withdrawal_evidence_no_delete;
ALTER TABLE activity_correlation_decisions DISABLE TRIGGER activity_correlation_decisions_no_delete;
ALTER TABLE activity_relationships DISABLE TRIGGER activity_relationships_no_delete;

DELETE FROM notification_events WHERE kind='live_activity';
DELETE FROM live_activities;

ALTER TABLE delivery_attempts ENABLE TRIGGER delivery_attempts_no_delete;
ALTER TABLE notification_withdrawal_evidence ENABLE TRIGGER notification_withdrawal_evidence_no_delete;
ALTER TABLE activity_correlation_decisions ENABLE TRIGGER activity_correlation_decisions_no_delete;
ALTER TABLE activity_relationships ENABLE TRIGGER activity_relationships_no_delete;

-- A current app must pair again. This prevents an already-installed build from
-- silently receiving payloads it was not compiled to decode.
UPDATE device_credentials
SET revoked_at=COALESCE(revoked_at,now());

UPDATE devices
SET revoked_at=COALESCE(revoked_at,now()),
    apns_token=NULL,
    live_activity_push_to_start_token=NULL;

ALTER TABLE devices
  DROP COLUMN live_activity_schema_version,
  DROP COLUMN interaction_capability_version,
  DROP COLUMN capabilities;

DROP TABLE pairing_codes;
DELETE FROM connection_grants;

ALTER TABLE live_activities
  DROP COLUMN requester_legacy_unknown,
  DROP CONSTRAINT live_activities_presentation_version_check,
  DROP CONSTRAINT live_activities_no_retired_fallback_check,
  ADD CONSTRAINT live_activities_current_presentation_check CHECK (
    jsonb_typeof(presentation)='object'
    AND NOT (presentation ? 'version')
    AND NOT (presentation ? 'fallback')
    AND NOT (presentation @? '$.components[*] ? (@.type == "progress_ring")')
    AND octet_length(presentation::text)<=4096
  );

CREATE UNIQUE INDEX live_activities_principal_active_key_idx
  ON live_activities(principal_id,activity_key)
  WHERE requester_service_id IS NULL AND requester_credential_id IS NULL
    AND activity_key IS NOT NULL AND state='active'
    AND style IN ('standard','ring','hero','terminal','steps');

ALTER TABLE live_activity_operations
  DROP COLUMN requester_legacy_unknown,
  DROP CONSTRAINT live_activity_operations_presentation_version_check,
  DROP CONSTRAINT live_activity_operations_no_retired_fallback_check,
  ADD CONSTRAINT live_activity_operations_current_presentation_check CHECK (
    jsonb_typeof(presentation_snapshot)='object'
    AND NOT (presentation_snapshot ? 'version')
    AND NOT (presentation_snapshot ? 'fallback')
    AND NOT (presentation_snapshot @? '$.components[*] ? (@.type == "progress_ring")')
    AND octet_length(presentation_snapshot::text)<=4096
  );

COMMENT ON COLUMN live_activities.presentation IS
  'The single current canonical presentation. Versioned and fallback shapes are rejected.';
COMMENT ON COLUMN live_activity_operations.presentation_snapshot IS
  'The single current canonical presentation captured with the immutable operation snapshot.';
