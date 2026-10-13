-- End-to-end sealed names for an agent session's opaque project, computer and account handles
-- (docs/END-TO-END-ENCRYPTION.md, E2.5). Only the account's phones can open it; the server stores
-- it as is and deletes it with the session.
ALTER TABLE agent_sessions ADD COLUMN sealed_names jsonb;
