ALTER TYPE delivery_state ADD VALUE 'reconciliation_required';

ALTER TABLE delivery_jobs
  ADD COLUMN apns_payload_sha256 text,
  ADD COLUMN provider_outcome_category text,
  ADD COLUMN provider_status integer,
  ADD COLUMN provider_transport_code text,
  ADD COLUMN last_provider_attempt_at timestamptz,
  ADD COLUMN provider_attempts_used integer NOT NULL DEFAULT 0,
  ADD COLUMN provider_retry_started_at timestamptz,
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_started_at timestamptz,
  ADD COLUMN claim_phase text;

ALTER TABLE delivery_jobs
  ADD CONSTRAINT delivery_jobs_apns_payload_sha256_check
    CHECK (apns_payload_sha256 IS NULL OR apns_payload_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT delivery_jobs_provider_status_check
    CHECK (provider_status IS NULL OR provider_status BETWEEN 100 AND 599),
  ADD CONSTRAINT delivery_jobs_provider_attempts_used_check
    CHECK (provider_attempts_used >= 0),
  ADD CONSTRAINT delivery_jobs_provider_attempt_horizon_check
    CHECK ((provider_attempts_used=0 AND provider_retry_started_at IS NULL)
      OR (provider_attempts_used>0 AND provider_retry_started_at IS NOT NULL)),
  ADD CONSTRAINT delivery_jobs_claim_state_check
    CHECK (claim_token IS NULL OR state='processing'),
  ADD CONSTRAINT delivery_jobs_claim_phase_check
    CHECK (claim_phase IS NULL OR (
      state='processing' AND claim_token IS NOT NULL
      AND claim_phase IN ('preparing','dispatch_started')
    ));

CREATE UNIQUE INDEX delivery_jobs_claim_token_idx
  ON delivery_jobs(claim_token) WHERE claim_token IS NOT NULL;

INSERT INTO notification_event_targets(notification_event_id,device_id)
SELECT notification_event_id,device_id FROM delivery_jobs
ON CONFLICT DO NOTHING;

CREATE FUNCTION bind_delivery_job_target() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notification_event_targets(notification_event_id,device_id)
  VALUES (NEW.notification_event_id,NEW.device_id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_jobs_bind_exact_target
AFTER INSERT ON delivery_jobs
FOR EACH ROW EXECUTE FUNCTION bind_delivery_job_target();

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_job_id uuid NOT NULL REFERENCES delivery_jobs(id) ON DELETE CASCADE,
  claim_token uuid NOT NULL,
  job_attempt integer NOT NULL CHECK (job_attempt > 0),
  provider_attempts integer NOT NULL CHECK (provider_attempts >= 0),
  outcome_category text NOT NULL,
  provider_status integer CHECK (provider_status IS NULL OR provider_status BETWEEN 100 AND 599),
  provider_reason text,
  provider_message_id text,
  transport_code text,
  invalidated_at timestamptz,
  provider_first_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider_attempts=0 OR provider_first_attempt_at IS NOT NULL),
  UNIQUE (delivery_job_id, job_attempt),
  UNIQUE (claim_token)
);

CREATE INDEX delivery_attempts_job_created_idx
  ON delivery_attempts(delivery_job_id,created_at,id);

CREATE FUNCTION reject_delivery_attempt_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery_attempts rows are append-only';
END;
$$;

CREATE TRIGGER delivery_attempts_no_update
BEFORE UPDATE ON delivery_attempts
FOR EACH ROW EXECUTE FUNCTION reject_delivery_attempt_update();

CREATE FUNCTION reject_delivery_attempt_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery_attempts rows are append-only';
END;
$$;

CREATE TRIGGER delivery_attempts_no_delete
BEFORE DELETE ON delivery_attempts
FOR EACH ROW EXECUTE FUNCTION reject_delivery_attempt_delete();

REVOKE UPDATE,DELETE ON delivery_attempts FROM PUBLIC;

COMMENT ON TRIGGER delivery_attempts_no_delete ON delivery_attempts IS
  'Retention deletion is unsupported at runtime; a reviewed schema-owner migration must explicitly disable this trigger inside its controlled transaction.';
