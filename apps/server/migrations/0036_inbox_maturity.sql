ALTER TYPE notification_state ADD VALUE IF NOT EXISTS 'withdrawn';

ALTER TABLE notification_events
  ADD COLUMN read_at timestamptz,
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_by_kind text,
  ADD COLUMN withdrawn_by_id uuid,
  ADD CONSTRAINT notification_events_withdrawal_shape CHECK (
    (withdrawn_at IS NULL AND withdrawn_by_kind IS NULL AND withdrawn_by_id IS NULL)
    OR (withdrawn_at IS NOT NULL AND withdrawn_by_kind IN ('credential','service','dashboard')
      AND withdrawn_by_id IS NOT NULL)
  );

CREATE INDEX notification_events_unread_idx
  ON notification_events(principal_id,created_at DESC,id DESC)
  WHERE read_at IS NULL AND withdrawn_at IS NULL;

CREATE TABLE notification_contents (
  notification_event_id uuid PRIMARY KEY REFERENCES notification_events(id) ON DELETE CASCADE,
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 240),
  body_ciphertext text NOT NULL,
  body_format text NOT NULL CHECK (body_format IN ('text','markdown')),
  body_bytes integer NOT NULL CHECK (body_bytes BETWEEN 1 AND 65536),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_withdrawal_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  notification_event_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  requester_kind text NOT NULL CHECK (requester_kind IN ('credential','service','dashboard')),
  requester_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN (
    'canonical_withdrawn','pending_delivery_canceled','sync_command_queued',
    'sync_command_accepted','sync_command_retry','sync_command_failed','device_confirmed'
  )),
  delivery_job_id uuid REFERENCES delivery_jobs(id) ON DELETE SET NULL,
  detail_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (requester_kind,requester_id,idempotency_key,device_id,outcome)
);

CREATE INDEX notification_withdrawal_evidence_event_idx
  ON notification_withdrawal_evidence(notification_event_id,created_at,id);

CREATE FUNCTION reject_notification_withdrawal_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notification_withdrawal_evidence rows are append-only';
END;
$$;

CREATE TRIGGER notification_withdrawal_evidence_no_update
BEFORE UPDATE ON notification_withdrawal_evidence
FOR EACH ROW EXECUTE FUNCTION reject_notification_withdrawal_evidence_mutation();

CREATE TRIGGER notification_withdrawal_evidence_no_delete
BEFORE DELETE ON notification_withdrawal_evidence
FOR EACH ROW EXECUTE FUNCTION reject_notification_withdrawal_evidence_mutation();

GRANT SELECT,INSERT,UPDATE ON notification_contents TO relo_runtime;
GRANT SELECT,INSERT ON notification_withdrawal_evidence TO relo_runtime;
REVOKE UPDATE,DELETE ON notification_withdrawal_evidence FROM relo_runtime;

COMMENT ON COLUMN notification_events.read_at IS
  'Account-level monotonic read state shared by Dashboard and all owner devices.';
COMMENT ON TABLE notification_contents IS
  'Purpose-encrypted long notification content; event.body retains only the APNs-safe preview.';
COMMENT ON TABLE notification_withdrawal_evidence IS
  'Append-only best-effort withdrawal outcomes; provider acceptance never implies device removal.';
