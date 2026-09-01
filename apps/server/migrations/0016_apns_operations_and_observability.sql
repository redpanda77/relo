CREATE INDEX delivery_attempts_created_desc_idx
  ON delivery_attempts(created_at DESC,id DESC);

ALTER TABLE delivery_jobs
  ADD COLUMN first_claimed_at timestamptz,
  ADD COLUMN last_claimed_at timestamptz,
  ADD COLUMN last_dispatch_started_at timestamptz,
  ADD COLUMN apns_priority smallint CHECK (apns_priority IN (5,10));

CREATE FUNCTION notify_ready_delivery_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('pending','retry') AND NEW.available_at<=clock_timestamp() THEN
    PERFORM pg_notify('relo_delivery_jobs','ready');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_jobs_notify_ready
AFTER INSERT OR UPDATE OF state,available_at ON delivery_jobs
FOR EACH ROW EXECUTE FUNCTION notify_ready_delivery_job();

CREATE TABLE apns_operation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation text NOT NULL CHECK (operation IN ('cutover_quarantine','rollback_quarantine')),
  apns_mode text NOT NULL CHECK (apns_mode IN ('disabled','sandbox','production')),
  cutover_at timestamptz NOT NULL,
  configuration_generation text NOT NULL
    CHECK (configuration_generation ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  counts jsonb NOT NULL CHECK (jsonb_typeof(counts)='object' AND octet_length(counts::text)<=16384),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX apns_operation_audit_created_desc_idx
  ON apns_operation_audit(created_at DESC,id DESC);

CREATE FUNCTION reject_apns_operation_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'apns_operation_audit rows are append-only';
END;
$$;

CREATE TRIGGER apns_operation_audit_no_update
BEFORE UPDATE ON apns_operation_audit
FOR EACH ROW EXECUTE FUNCTION reject_apns_operation_audit_mutation();

CREATE TRIGGER apns_operation_audit_no_delete
BEFORE DELETE ON apns_operation_audit
FOR EACH ROW EXECUTE FUNCTION reject_apns_operation_audit_mutation();

REVOKE UPDATE,DELETE,TRUNCATE ON apns_operation_audit FROM PUBLIC;
GRANT SELECT,INSERT ON apns_operation_audit TO relo_runtime;
REVOKE UPDATE,DELETE,TRUNCATE ON apns_operation_audit FROM relo_runtime;

COMMENT ON TABLE apns_operation_audit IS
  'Append-only, redacted evidence for APNs cutover and rollback quarantine operations.';
