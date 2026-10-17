-- Tokens in a session's context window, read by the CLI's hooks from the session's transcript (the status line,
-- source of context_pct, does not run in the Claude desktop app). Observed display fact; nothing derives from it.
ALTER TABLE agent_sessions
  ADD COLUMN context_tokens integer CHECK (context_tokens BETWEEN 0 AND 10000000);
