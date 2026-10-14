-- Agent sessions: a "wait" event (Claude Code's Notification hook for a permission or input prompt)
-- marks a session that needs the owner. It is stored like a stop (state idle) so the card rules
-- treat it as between turns; the listing reads it as "waiting" (see agentSessionPhase).
ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_last_event_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_last_event_check
  CHECK (last_event IN ('start','prompt','tool','stop','wait','end'));

-- A prompt after a stop changes the phase but not the state (both idle): wake the phones for it too.
DROP TRIGGER current_agent_session_update ON agent_sessions;
CREATE TRIGGER current_agent_session_update AFTER UPDATE OF state,card_key,last_event ON agent_sessions
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.card_key IS DISTINCT FROM NEW.card_key
  OR (NEW.last_event='wait' AND OLD.last_event IS DISTINCT FROM 'wait'))
EXECUTE FUNCTION notify_current_change();
