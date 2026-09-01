ALTER TABLE live_activities
  ADD COLUMN start_request_hash text,
  ADD COLUMN start_delivery_summary jsonb NOT NULL DEFAULT
    '{"eligibleDevices":0,"durableCommands":0,"apnsJobs":0}'::jsonb,
  ADD COLUMN start_snapshot jsonb,
  ADD COLUMN context jsonb;

ALTER TABLE live_activity_operations
  ADD COLUMN request_hash text,
  ADD COLUMN delivery_summary jsonb NOT NULL DEFAULT
    '{"eligibleDevices":0,"durableCommands":0,"apnsJobs":0}'::jsonb,
  ADD COLUMN activity_snapshot jsonb,
  ADD COLUMN dismiss_after_seconds integer
    CHECK (dismiss_after_seconds IS NULL OR dismiss_after_seconds BETWEEN 0 AND 14400);

ALTER TABLE notification_events
  ADD COLUMN request_hash text,
  ADD COLUMN delivery_summary jsonb,
  ADD COLUMN target_mode text NOT NULL DEFAULT 'broadcast'
    CHECK (target_mode IN ('broadcast','explicit'));

-- Pre-0004 rows did not record whether routing was broadcast or explicit. That
-- intent cannot be reconstructed safely, so every legacy row fails closed.
-- Only devices evidenced by historical delivery jobs retain visibility; a
-- legacy row with no delivery job intentionally becomes invisible.
UPDATE notification_events SET target_mode='explicit';

CREATE TABLE notification_event_targets (
  notification_event_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(notification_event_id,device_id)
);

CREATE INDEX notification_event_targets_device_idx
  ON notification_event_targets(device_id,notification_event_id);

-- Historical delivery jobs are the only trustworthy record of a recipient.
INSERT INTO notification_event_targets(notification_event_id,device_id)
SELECT notification_event_id,device_id FROM delivery_jobs
ON CONFLICT DO NOTHING;
