-- A session's readable name, sent only on accounts that are not encrypted (otherwise it travels in sealed_names).
ALTER TABLE agent_sessions ADD COLUMN title text;
