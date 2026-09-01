ALTER TABLE delivery_jobs
  ADD COLUMN serializer_revision smallint NOT NULL DEFAULT 1,
  ADD COLUMN canonical_intent_sha256 text,
  ADD COLUMN device_projection_sha256 text;

ALTER TABLE delivery_jobs
  ADD CONSTRAINT delivery_jobs_serializer_revision_check
    CHECK (serializer_revision IN (1,2)),
  ADD CONSTRAINT delivery_jobs_canonical_intent_sha256_check
    CHECK (canonical_intent_sha256 IS NULL OR canonical_intent_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT delivery_jobs_device_projection_sha256_check
    CHECK (device_projection_sha256 IS NULL OR device_projection_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE delivery_jobs ALTER COLUMN serializer_revision SET DEFAULT 2;

COMMENT ON COLUMN delivery_jobs.serializer_revision IS
  'Pinned serializer contract. Revision 1 identifies jobs queued before 0032; revision 2 is the current deterministic projection contract.';
COMMENT ON COLUMN delivery_jobs.canonical_intent_sha256 IS
  'SHA-256 identity of the immutable canonical delivery intent, pinned before the APNs dispatch fence.';
COMMENT ON COLUMN delivery_jobs.device_projection_sha256 IS
  'SHA-256 identity of the exact device projection, pinned before the APNs dispatch fence.';
