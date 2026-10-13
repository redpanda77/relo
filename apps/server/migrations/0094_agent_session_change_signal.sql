-- Phones read agent sessions with the inbox; a session that starts, stops (idle), ends or links a
-- card wakes their current-state stream so they read it again. Tool events only move
-- last_event_at and stay silent: at most one hint per state change, never one per tool call.
CREATE TRIGGER current_agent_session_insert_delete AFTER INSERT OR DELETE ON agent_sessions
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_agent_session_update AFTER UPDATE OF state,card_key ON agent_sessions
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.card_key IS DISTINCT FROM NEW.card_key)
EXECUTE FUNCTION notify_current_change();
