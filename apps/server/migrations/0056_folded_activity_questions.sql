-- A question asked on a card folds into that card instead of starting a companion.
-- resume_presentation holds the working presentation to restore once the question
-- settles; updates that arrive while it is pending land here instead of cancelling it.
ALTER TABLE live_activities ADD COLUMN resume_presentation jsonb;
-- Set once the owner was told by notification that a card question could not be shown.
ALTER TABLE live_activities ADD COLUMN question_fallback_at timestamptz;
-- Folded questions are not keyed by the operation's idempotency key; keep the exact request.
ALTER TABLE live_activity_operations ADD COLUMN interaction_request_id uuid
  REFERENCES interaction_requests(id) ON DELETE SET NULL;
CREATE INDEX live_activities_pending_question ON live_activities(updated_at)
  WHERE state='active' AND resume_presentation IS NOT NULL AND question_fallback_at IS NULL;
