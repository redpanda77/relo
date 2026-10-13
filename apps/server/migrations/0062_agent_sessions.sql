-- Agent sessions: a signal channel separate from cards and questions. Hooks report facts about a
-- running harness session; the worker reconciles them with cards (docs/internal/product/
-- CLI-AGENT-INTEGRATION-PLAN.md, Phase 4). The session id is a hash the CLI computes; no prompt,
-- tool input or transcript content is ever stored.
CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  session_hash text NOT NULL CHECK (session_hash ~ '^[A-Za-z0-9_-]{16,128}$'),
  harness text NOT NULL CHECK (char_length(harness) BETWEEN 1 AND 40),
  computer text CHECK (computer IS NULL OR char_length(computer) BETWEEN 1 AND 120),
  account text CHECK (account IS NULL OR char_length(account) BETWEEN 1 AND 40),
  project text CHECK (project IS NULL OR char_length(project) BETWEEN 1 AND 120),
  state text NOT NULL CHECK (state IN ('active','idle','ended','lost')),
  started_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  last_event text NOT NULL CHECK (last_event IN ('start','prompt','tool','stop','end')),
  -- For ended sessions the end event; for lost sessions the moment silence reached the lost threshold.
  ended_at timestamptz,
  ended_reason text CHECK (ended_reason IN ('session_end','lost')),
  -- The activity key the CLI derives for this session's card (session-<agent>-<hash>).
  card_key text CHECK (card_key IS NULL OR char_length(card_key) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id, session_hash)
);

-- Owner listing: live and recent sessions of an account, newest first.
CREATE INDEX agent_sessions_principal_recent_idx ON agent_sessions (principal_id, last_event_at DESC);
-- Reconciler: sessions that may have gone quiet (active/idle) and ended/lost sessions that may still
-- hold a card; both stay small because settled rows leave the partial indexes.
CREATE INDEX agent_sessions_live_idx ON agent_sessions (last_event_at) WHERE state IN ('active','idle');
CREATE INDEX agent_sessions_card_pending_idx ON agent_sessions (principal_id, card_key)
  WHERE state IN ('ended','lost') AND card_key IS NOT NULL;

GRANT SELECT,INSERT,UPDATE,DELETE ON agent_sessions TO relo_runtime;

-- New API keys may post session events by default. Existing keys keep their scopes: holders of
-- activities:write are accepted by the route too (they already control the session's card).
ALTER TABLE principal_api_keys
  ALTER COLUMN scopes SET DEFAULT ARRAY[
    'notifications:send','interactions:create','interactions:read',
    'activities:write','activities:read','sessions:write','devices:pair','devices:read',
    'services:read','services:write'
  ]::text[];
