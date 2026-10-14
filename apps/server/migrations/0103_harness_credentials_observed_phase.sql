-- Edge architecture (ADR 0008, plan HA.1 and EDGE.2): the CLI runs each session's state machine
-- locally and reports only phase snapshots; hooks hold their own credential.

-- Harness credentials: the hooks' credential (kind "harness", scope presence:write only). A
-- separate table, not a flavour of principal_api_keys: it can post observed snapshots and nothing
-- else, and declared credentials can never post them. Hashed at rest like other machine tokens.
CREATE TABLE harness_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  token_prefix text NOT NULL CHECK (char_length(token_prefix) BETWEEN 1 AND 20),
  -- The owner CLI credential that minted it (traceability only).
  created_by_key_id uuid REFERENCES principal_api_keys(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX harness_credentials_principal_idx ON harness_credentials (principal_id, created_at DESC)
  WHERE revoked_at IS NULL;
GRANT SELECT,INSERT,UPDATE,DELETE ON harness_credentials TO relo_runtime;

-- sessions:write is gone: declared credentials never write observed state.
UPDATE principal_api_keys SET scopes=array_remove(scopes,'sessions:write') WHERE 'sessions:write'=ANY(scopes);
UPDATE device_authorizations SET requested_scopes=array_remove(requested_scopes,'sessions:write')
  WHERE 'sessions:write'=ANY(requested_scopes);
ALTER TABLE principal_api_keys
  ALTER COLUMN scopes SET DEFAULT ARRAY[
    'notifications:send','interactions:create','interactions:read',
    'activities:write','activities:read','devices:pair','devices:read',
    'services:read','services:write'
  ]::text[];

-- Agent sessions store the last reported phase snapshot, never raw events. Rows from the event
-- stream mean nothing in the new shape and are dropped (dev mode: one owner, hooks re-report).
DELETE FROM agent_sessions;
DROP TRIGGER IF EXISTS current_agent_session_update ON agent_sessions;
DROP INDEX IF EXISTS agent_sessions_live_idx;
DROP INDEX IF EXISTS agent_sessions_principal_recent_idx;
ALTER TABLE agent_sessions
  DROP COLUMN state,
  DROP COLUMN last_event,
  DROP COLUMN last_event_at,
  DROP COLUMN ended_at,
  DROP COLUMN ended_reason,
  ADD COLUMN phase text NOT NULL CHECK (phase IN ('open','working','waiting','stopped','ended')),
  ADD COLUMN phase_since timestamptz NOT NULL,
  ADD COLUMN last_seen_at timestamptz NOT NULL,
  ADD COLUMN open_tool_since timestamptz,
  -- The CLI's per-session snapshot counter: only a greater seq is applied (ordered, idempotent).
  ADD COLUMN seq bigint NOT NULL CHECK (seq > 0);

CREATE INDEX agent_sessions_principal_recent_idx ON agent_sessions (principal_id, last_seen_at DESC);
CREATE INDEX agent_sessions_retention_idx ON agent_sessions (last_seen_at);

-- Phones read sessions with the inbox: a phase change wakes their current-state stream. A
-- heartbeat only moves last_seen_at and stays silent, unless the session had been silent long
-- enough (T_fresh/2) to read as stopped responding: seeing it again changes what the owner sees.
CREATE TRIGGER current_agent_session_update AFTER UPDATE OF phase,last_seen_at ON agent_sessions
FOR EACH ROW WHEN (OLD.phase IS DISTINCT FROM NEW.phase
  OR NEW.last_seen_at - OLD.last_seen_at >= interval '10 minutes')
EXECUTE FUNCTION notify_current_change();
