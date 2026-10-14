-- STATE-SPEC 6.2: device dismissal never applies to Needs you. Dismissing a missed question is the
-- owner's decision that it no longer needs them: it leaves Needs you on every surface, stays in
-- History, and closes the late-answer path for that question.
ALTER TABLE interaction_requests
  ADD COLUMN owner_dismissed_at timestamptz,
  ADD COLUMN dismissed_by_device uuid REFERENCES devices(id) ON DELETE SET NULL,
  -- Only a missed question (expired, never answered late) can be dismissed.
  ADD CONSTRAINT interaction_requests_owner_dismissal_check
    CHECK (owner_dismissed_at IS NULL OR state='expired' AND late_responded_at IS NULL);

-- Other phones re-read Now when a question is dismissed.
CREATE TRIGGER current_interaction_dismissal AFTER UPDATE OF owner_dismissed_at ON interaction_requests
FOR EACH ROW WHEN (OLD.owner_dismissed_at IS DISTINCT FROM NEW.owner_dismissed_at)
EXECUTE FUNCTION notify_current_change();
