ALTER TABLE delivery_jobs ADD COLUMN activity_provider_timestamp bigint
  CHECK (activity_provider_timestamp BETWEEN 0 AND 9007199254740991);

-- Preserve existing pinned bytes. Never recompute a legacy fenced timestamp.
UPDATE delivery_jobs j SET activity_provider_timestamp=(e.payload#>>'{liveActivity,providerTimestamp}')::bigint
FROM notification_events e WHERE e.id=j.notification_event_id
  AND j.transport IN ('live_activity_start','live_activity_update')
  AND j.canonical_intent_sha256 IS NOT NULL
  AND (e.payload#>>'{liveActivity,providerTimestamp}') ~ '^[0-9]{1,15}$';

CREATE TABLE activity_delivery_heads (
  live_activity_id uuid NOT NULL REFERENCES live_activities(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation>0),
  last_provider_timestamp bigint CHECK (last_provider_timestamp>=0),
  PRIMARY KEY (live_activity_id,device_id,generation)
);

INSERT INTO activity_delivery_heads(live_activity_id,device_id,generation,last_provider_timestamp)
SELECT j.live_activity_id,j.device_id,(e.payload#>>'{liveActivity,generation}')::bigint,
  max(j.activity_provider_timestamp)
FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
WHERE j.live_activity_id IS NOT NULL AND j.activity_provider_timestamp IS NOT NULL
  AND (e.payload#>>'{liveActivity,generation}') ~ '^[1-9][0-9]{0,14}$'
GROUP BY j.live_activity_id,j.device_id,(e.payload#>>'{liveActivity,generation}')::bigint;

GRANT SELECT,INSERT,UPDATE ON activity_delivery_heads TO relo_runtime;
REVOKE DELETE,TRUNCATE ON activity_delivery_heads FROM relo_runtime;

COMMENT ON TABLE activity_delivery_heads IS
  'Last actual fenced ActivityKit second per native identity. Independent of domain revision count and retained after event pruning.';
