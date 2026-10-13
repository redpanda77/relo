-- Preserve the configured cadence independently of delayed occurrence and expiry.
-- Nullable for historical rows; the next admitted producer mutation resolves it.
ALTER TABLE live_activities ADD COLUMN stale_after_seconds integer
  CHECK (stale_after_seconds >= 0 AND stale_after_seconds <= 28800);
