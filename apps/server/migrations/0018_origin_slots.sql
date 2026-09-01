ALTER TABLE live_activities
  ADD COLUMN origin_hash text,
  ADD CONSTRAINT live_activities_origin_hash_format
    CHECK (origin_hash IS NULL OR origin_hash ~ '^org_[A-Za-z0-9_-]{43}$');

ALTER TABLE notification_events
  ADD COLUMN origin_hash text,
  ADD CONSTRAINT notification_events_origin_hash_format
    CHECK (origin_hash IS NULL OR origin_hash ~ '^org_[A-Za-z0-9_-]{43}$');

-- One durable lifecycle row owns an origin forever. Terminal rows are
-- tombstones: a delayed start or update cannot create a replacement generation.
-- Legacy callers remain governed by their existing key/requester constraints.
CREATE UNIQUE INDEX live_activities_origin_slot_idx
  ON live_activities(principal_id,origin_hash)
  WHERE origin_hash IS NOT NULL;

-- Notification rows remain immutable and distinct. This index only groups their
-- retained history and supports a stable APNs collapse/replacement identifier.
CREATE INDEX notification_events_origin_history_idx
  ON notification_events(principal_id,origin_hash,created_at DESC,id DESC)
  WHERE origin_hash IS NOT NULL;
