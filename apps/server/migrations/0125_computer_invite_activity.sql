-- The phone's wizard Live Activity (plan 13, journey E): the push token ActivityKit gave it (sealed like the other
-- transport tokens), the last state pushed so a state is never pushed twice, and a flag the API sets when the invite
-- may have moved. The worker loop (computer-invite-activity.ts) turns the flag into one push.
ALTER TABLE computer_invites
  ADD COLUMN activity_push_token text,
  ADD COLUMN activity_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  ADD COLUMN activity_last_state text,
  ADD COLUMN activity_push_pending boolean NOT NULL DEFAULT false;
CREATE INDEX computer_invites_activity_pending ON computer_invites(id) WHERE activity_push_pending AND activity_push_token IS NOT NULL;
