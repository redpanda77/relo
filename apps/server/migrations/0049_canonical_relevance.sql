-- Subject identity survives history pruning. There is deliberately no FK from
-- the current receipt to its prunable event; it is a replay fence, not history.
CREATE TABLE relevance_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
  subject_key text NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 200),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  intent_sha256 text NOT NULL CHECK (intent_sha256 ~ '^[a-f0-9]{64}$'),
  current_event_id uuid NOT NULL,
  current_relevance jsonb NOT NULL CHECK (jsonb_typeof(current_relevance)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(principal_id,source_id,subject_key)
);
CREATE TABLE notification_relevance (
  notification_event_id uuid PRIMARY KEY REFERENCES notification_events(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES relevance_subjects(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  relevance jsonb NOT NULL CHECK (jsonb_typeof(relevance)='object'),
  deliver_until timestamptz NOT NULL,
  action_expires_at timestamptz,
  relevant_until timestamptz,
  fresh_until timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX notification_relevance_subject_version_idx
  ON notification_relevance(subject_id,generation,revision);
CREATE INDEX notification_relevance_delivery_idx
  ON notification_relevance(deliver_until) WHERE superseded_at IS NULL;
CREATE INDEX interaction_requests_pending_expiry_idx
  ON interaction_requests(expires_at,id) WHERE state='pending';
GRANT SELECT,INSERT,UPDATE ON relevance_subjects,notification_relevance TO relo_runtime;
REVOKE DELETE ON relevance_subjects,notification_relevance FROM relo_runtime;
