ALTER TABLE delivery_jobs
  ADD COLUMN recipient_authorized_at timestamptz,
  ADD COLUMN recipient_generation text,
  ADD CONSTRAINT delivery_jobs_recipient_authorization_check CHECK (
    (recipient_authorized_at IS NULL AND recipient_generation IS NULL)
    OR (recipient_authorized_at IS NOT NULL AND recipient_generation IS NOT NULL
      AND recipient_generation ~ '^[a-f0-9]{64}$')
  );

COMMENT ON COLUMN delivery_jobs.recipient_generation IS
  'Opaque hash of the encrypted token captured by the latest short authorization fence. This is evidence of an in-flight attempt, not a promise of recall after revocation.';
