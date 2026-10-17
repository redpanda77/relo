-- Display facts the CLI's status line wrapper observes per session: how full the context window is and
-- what the session has cost. Observed only; nothing derives from them.
ALTER TABLE agent_sessions
  ADD COLUMN context_pct smallint CHECK (context_pct BETWEEN 0 AND 100),
  ADD COLUMN cost_usd numeric(10,2) CHECK (cost_usd >= 0);
