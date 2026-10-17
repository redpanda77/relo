-- Add a computer: the owner picks which agents relo setup sets up on the new computer (harness ids such as
-- claude-code, codex, opencode). Null: every agent the computer has.
ALTER TABLE computer_invites ADD COLUMN setup_agents text[]
  CHECK (setup_agents IS NULL OR (cardinality(setup_agents) BETWEEN 1 AND 12));
