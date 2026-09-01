-- Relo has one current delivery serializer. Queued work is repinned by the
-- current worker; the database no longer carries a selectable old revision.
UPDATE delivery_jobs
SET canonical_intent_sha256=NULL,
    device_projection_sha256=NULL;

ALTER TABLE delivery_jobs
  DROP CONSTRAINT delivery_jobs_serializer_revision_check,
  DROP COLUMN serializer_revision;

COMMENT ON COLUMN delivery_jobs.canonical_intent_sha256 IS
  'Hash of the canonical delivery intent produced by the current serializer.';
COMMENT ON COLUMN delivery_jobs.device_projection_sha256 IS
  'Hash of the device projection produced by the current serializer.';
