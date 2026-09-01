ALTER TABLE delivery_jobs
  ADD COLUMN transport text NOT NULL DEFAULT 'notification'
    CHECK (transport IN ('notification','live_activity_start','live_activity_update')),
  ADD COLUMN live_activity_id uuid REFERENCES live_activities(id) ON DELETE CASCADE;

CREATE INDEX delivery_jobs_live_activity_idx
  ON delivery_jobs(live_activity_id,device_id,created_at)
  WHERE live_activity_id IS NOT NULL;

CREATE TABLE live_activity_update_tokens (
  live_activity_id uuid NOT NULL REFERENCES live_activities(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  native_activity_id text NOT NULL,
  token text NOT NULL,
  environment apns_environment NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(live_activity_id,device_id)
);
