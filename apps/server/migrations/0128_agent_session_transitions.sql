-- Observed phase transitions per session, append-only: one row each time an accepted snapshot changes a
-- session's phase. Measures false "Needs you" (a wait that ends with the session) and time to clear an
-- ended session. Written only by the observed upsert; nothing derives from it, and it never changes a card,
-- question or work. Rows go with their session and after the same 7-day retention.
CREATE TABLE agent_session_transitions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  previous_phase text CHECK (previous_phase IS NULL OR previous_phase IN ('open','working','waiting','stopped','ended')),
  -- The session's last sign of life before this change; time to clear counts from it.
  previous_last_seen_at timestamptz,
  new_phase text NOT NULL CHECK (new_phase IN ('open','working','waiting','stopped','ended')),
  phase_since timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- How an ended session ended: the SessionEnd hook, the CLI's dead-process sweep, or the Relo MCP server.
  end_reason text CHECK (end_reason IS NULL OR end_reason IN ('hook','gone','mcp'))
);

CREATE INDEX agent_session_transitions_session_idx ON agent_session_transitions (session_id, phase_since, id);
-- Retention pass.
CREATE INDEX agent_session_transitions_recorded_idx ON agent_session_transitions (recorded_at);

GRANT SELECT,INSERT,DELETE ON agent_session_transitions TO relo_runtime;
