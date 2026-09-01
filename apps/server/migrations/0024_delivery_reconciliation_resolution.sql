CREATE TABLE delivery_reconciliation_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_job_id uuid NOT NULL UNIQUE REFERENCES delivery_jobs(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  actor_kind text NOT NULL CHECK (actor_kind IN ('credential','dashboard')),
  actor_credential_id uuid REFERENCES principal_api_keys(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('mark_accepted','retry','cancel')),
  previous_error_code text,
  resulting_state delivery_state NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((actor_kind='credential' AND actor_credential_id IS NOT NULL)
    OR (actor_kind='dashboard' AND actor_credential_id IS NULL))
);

CREATE INDEX delivery_reconciliation_resolutions_principal_created_idx
  ON delivery_reconciliation_resolutions(principal_id,created_at DESC,id DESC);

CREATE FUNCTION reject_delivery_reconciliation_resolution_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery_reconciliation_resolutions rows are append-only';
END;
$$;

CREATE TRIGGER delivery_reconciliation_resolutions_no_update
BEFORE UPDATE ON delivery_reconciliation_resolutions
FOR EACH ROW EXECUTE FUNCTION reject_delivery_reconciliation_resolution_mutation();

REVOKE UPDATE,DELETE,TRUNCATE ON delivery_reconciliation_resolutions FROM PUBLIC;
GRANT SELECT,INSERT ON delivery_reconciliation_resolutions TO relo_runtime;
REVOKE UPDATE,DELETE,TRUNCATE ON delivery_reconciliation_resolutions FROM relo_runtime;

COMMENT ON TABLE delivery_reconciliation_resolutions IS
  'Runtime-append-only operator settlement evidence for APNs dispatch outcomes fenced as reconciliation_required; owner-driven cascade deletion remains available for bounded retention and account deletion.';
