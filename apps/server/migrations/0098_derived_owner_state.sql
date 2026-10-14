-- STATE-SPEC v2 slice 1: the derived owner state. Destructive fresh start (D11): no legacy mapping.

-- Fresh start: every open card is ended (no rollback target, no legacy rows to derive).
UPDATE live_activities SET state='ended', ended_at=COALESCE(ended_at,now()), updated_at=now() WHERE state='active';

-- Every card records its producer type (spec 11.1) and, for agent sessions only, the session key
-- that links it to that session's hook events.
ALTER TABLE live_activities
  ADD COLUMN producer_type text,
  ADD COLUMN session_key text,
  -- The last declared write (the producer's own start, update, end, ask). Server writes (a settled
  -- question, a retirement) never move it: it is the evidence clock's declared half.
  ADD COLUMN declared_at timestamptz;

UPDATE live_activities SET
  producer_type = CASE
    WHEN requester_service_id IS NOT NULL THEN 'service'
    WHEN activity_key LIKE 'session-%' AND activity_key NOT LIKE 'session-relo-%' THEN 'agent_session'
    ELSE 'script' END,
  declared_at = updated_at;

-- No default on producer_type: every insert names its type.
ALTER TABLE live_activities
  ALTER COLUMN producer_type SET NOT NULL,
  ALTER COLUMN declared_at SET NOT NULL,
  ALTER COLUMN declared_at SET DEFAULT now(),
  ADD CONSTRAINT live_activities_producer_type_check
    CHECK (producer_type IN ('agent_session','script','service')),
  ADD CONSTRAINT live_activities_service_producer_check
    CHECK ((producer_type = 'service') = (requester_service_id IS NOT NULL)),
  ADD CONSTRAINT live_activities_session_key_check
    CHECK (session_key IS NULL OR (producer_type = 'agent_session' AND session_key ~ '^[A-Za-z0-9_-]{16,128}$'));

CREATE INDEX live_activities_session_key_idx ON live_activities (principal_id, session_key)
  WHERE session_key IS NOT NULL;
-- The worker's retirement pass reads every active card.
CREATE INDEX live_activities_active_declared_idx ON live_activities (declared_at)
  WHERE state = 'active';

-- Display leases: when the card was (re)started on the device (ActivityKit 8 h limit) and the last
-- staleDate pushed to it. Retirement is display only: it writes the lease, never the card.
ALTER TABLE live_activity_presentation_leases
  ADD COLUMN presented_at timestamptz,
  ADD COLUMN stale_date_pushed timestamptz;

-- Questions are decoupled from cards (spec 7): an answer after the question expired is stored and
-- marked late. It is a fact for the agent, never permission (decision 3), so the request stays expired.
ALTER TABLE interaction_requests
  ADD COLUMN late_response jsonb,
  ADD COLUMN late_responded_at timestamptz,
  ADD CONSTRAINT interaction_requests_late_answer_check
    CHECK ((late_response IS NULL) = (late_responded_at IS NULL)
      AND (late_responded_at IS NULL OR state = 'expired'));

-- Stored "lost" is no longer truth (phases are derived): normalise to ended.
UPDATE agent_sessions SET state='ended' WHERE state='lost';

-- The card_key join (session → card by activity key) is dead. A card names its session instead.
DROP TRIGGER current_agent_session_update ON agent_sessions;
DROP INDEX IF EXISTS agent_sessions_card_pending_idx;
ALTER TABLE agent_sessions DROP COLUMN card_key;
-- One wake per turn edge: a prompt↔tool change stays silent.
CREATE TRIGGER current_agent_session_update AFTER UPDATE OF state,last_event ON agent_sessions
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state
  OR (OLD.last_event IS DISTINCT FROM NEW.last_event
      AND NOT (OLD.last_event IN ('prompt','tool') AND NEW.last_event IN ('prompt','tool'))))
EXECUTE FUNCTION notify_current_change();
