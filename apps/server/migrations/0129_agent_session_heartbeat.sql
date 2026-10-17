-- When the session's MCP server last sent a heartbeat for a session at a permission prompt (plan 14, workstream 1).
-- NULL: the session has no heartbeat source, so a prompt needs the owner until answered. Written only by the observed
-- upsert; derive() reads it as evidence and no phase, card or question follows from the column itself.
ALTER TABLE agent_sessions ADD COLUMN heartbeat_at timestamptz NULL;
