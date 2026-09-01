ALTER TABLE live_activities
  ADD COLUMN requester_service_id uuid REFERENCES webhook_services(id) ON DELETE CASCADE,
  ADD COLUMN requester_credential_id uuid REFERENCES principal_api_keys(id) ON DELETE CASCADE,
  ADD COLUMN requester_legacy_unknown boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT live_activities_requester_family_check
    CHECK (num_nonnulls(requester_service_id,requester_credential_id) <= 1);

ALTER TABLE live_activity_operations
  ADD COLUMN requester_service_id uuid REFERENCES webhook_services(id) ON DELETE CASCADE,
  ADD COLUMN requester_credential_id uuid REFERENCES principal_api_keys(id) ON DELETE CASCADE,
  ADD COLUMN requester_legacy_unknown boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT live_activity_operations_requester_family_check
    CHECK (num_nonnulls(requester_service_id,requester_credential_id) <= 1);

UPDATE live_activities SET requester_legacy_unknown=true;
UPDATE live_activity_operations SET requester_legacy_unknown=true;
UPDATE live_activities
SET state='expired',status='Expired during ownership migration',sequence=sequence+1,
    ended_at=COALESCE(ended_at,now()),updated_at=now()
WHERE requester_legacy_unknown=true AND state='active';

DROP INDEX IF EXISTS live_activities_principal_active_key_idx;
CREATE UNIQUE INDEX live_activities_principal_active_key_idx
  ON live_activities(principal_id,activity_key)
  WHERE requester_service_id IS NULL AND requester_credential_id IS NULL
    AND requester_legacy_unknown=false
    AND activity_key IS NOT NULL AND state='active'
    AND style IN ('standard','ring','hero','terminal','steps');
CREATE UNIQUE INDEX live_activities_service_active_key_idx
  ON live_activities(requester_service_id,activity_key)
  WHERE requester_service_id IS NOT NULL AND activity_key IS NOT NULL AND state='active'
    AND style IN ('standard','ring','hero','terminal','steps');
CREATE UNIQUE INDEX live_activities_credential_active_key_idx
  ON live_activities(requester_credential_id,activity_key)
  WHERE requester_credential_id IS NOT NULL AND activity_key IS NOT NULL AND state='active'
    AND style IN ('standard','ring','hero','terminal','steps');

ALTER TABLE live_activities
  DROP CONSTRAINT IF EXISTS live_activities_principal_id_start_idempotency_key_key;
CREATE UNIQUE INDEX live_activities_principal_start_idempotency_idx
  ON live_activities(principal_id,start_idempotency_key)
  WHERE requester_service_id IS NULL AND requester_credential_id IS NULL;
CREATE UNIQUE INDEX live_activities_service_start_idempotency_idx
  ON live_activities(requester_service_id,start_idempotency_key)
  WHERE requester_service_id IS NOT NULL;
CREATE UNIQUE INDEX live_activities_credential_start_idempotency_idx
  ON live_activities(requester_credential_id,start_idempotency_key)
  WHERE requester_credential_id IS NOT NULL;

ALTER TABLE live_activity_operations
  DROP CONSTRAINT IF EXISTS live_activity_operations_principal_idempotency_key_key;
CREATE UNIQUE INDEX live_activity_operations_principal_idempotency_idx
  ON live_activity_operations(principal_id,idempotency_key)
  WHERE requester_service_id IS NULL AND requester_credential_id IS NULL;
CREATE UNIQUE INDEX live_activity_operations_service_idempotency_idx
  ON live_activity_operations(requester_service_id,idempotency_key)
  WHERE requester_service_id IS NOT NULL;
CREATE UNIQUE INDEX live_activity_operations_credential_idempotency_idx
  ON live_activity_operations(requester_credential_id,idempotency_key)
  WHERE requester_credential_id IS NOT NULL;

CREATE INDEX live_activities_service_updated_idx
  ON live_activities(requester_service_id,updated_at DESC)
  WHERE requester_service_id IS NOT NULL;
CREATE INDEX live_activities_credential_updated_idx
  ON live_activities(requester_credential_id,updated_at DESC)
  WHERE requester_credential_id IS NOT NULL;
