ALTER TABLE live_activities
  ADD COLUMN lifecycle_provider text,
  ADD COLUMN lifecycle_run_id text,
  ADD CONSTRAINT live_activities_lifecycle_identity_pair CHECK (
    (lifecycle_provider IS NULL AND lifecycle_run_id IS NULL)
    OR
    (lifecycle_provider IS NOT NULL AND lifecycle_run_id IS NOT NULL)
  ),
  ADD CONSTRAINT live_activities_lifecycle_provider_format CHECK (
    lifecycle_provider IS NULL
    OR lifecycle_provider ~ '^[a-z0-9][a-z0-9._-]{0,39}$'
  ),
  ADD CONSTRAINT live_activities_lifecycle_run_id_format CHECK (
    lifecycle_run_id IS NULL
    OR lifecycle_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  );

CREATE UNIQUE INDEX live_activities_credential_lifecycle_run_idx
  ON live_activities(principal_id,requester_credential_id,lifecycle_provider,lifecycle_run_id)
  WHERE requester_credential_id IS NOT NULL
    AND requester_service_id IS NULL
    AND lifecycle_provider IS NOT NULL
    AND lifecycle_run_id IS NOT NULL;

CREATE UNIQUE INDEX live_activities_service_lifecycle_run_idx
  ON live_activities(principal_id,requester_service_id,lifecycle_provider,lifecycle_run_id)
  WHERE requester_service_id IS NOT NULL
    AND requester_credential_id IS NULL
    AND lifecycle_provider IS NOT NULL
    AND lifecycle_run_id IS NOT NULL;

CREATE INDEX live_activities_lifecycle_lookup_idx
  ON live_activities(principal_id,lifecycle_provider,lifecycle_run_id,created_at DESC)
  WHERE lifecycle_provider IS NOT NULL AND lifecycle_run_id IS NOT NULL;
