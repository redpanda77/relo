-- A notice during an open work is recorded on the work without a buzz of its own (spec 7, 2.13):
-- the finish outcome is the notification. Messages reference work, never own it.
ALTER TABLE notification_events
  ADD COLUMN work_id uuid REFERENCES works(id) ON DELETE SET NULL,
  ADD COLUMN folded boolean NOT NULL DEFAULT false;
CREATE INDEX notification_events_work_idx ON notification_events (work_id, created_at DESC) WHERE work_id IS NOT NULL;
