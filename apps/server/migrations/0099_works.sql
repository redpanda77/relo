-- STATE-SPEC v2 slice 2: works are declared state (one producer's goal, plan, lifecycle, outcome).
-- Cards are views of works. Producer identity is discriminated (one CHECK per type, no free mix).
-- Readable text exists only on accounts without end-to-end encryption; otherwise the text columns
-- are NULL and `sealed` carries the envelopes. Destructive fresh start (D11): no backfill.

CREATE TABLE works (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,

  -- Producer identity (2.2).
  producer_type text NOT NULL CHECK (producer_type IN ('agent_session','script','service')),
  credential_id uuid REFERENCES principal_api_keys(id) ON DELETE CASCADE,
  service_id uuid REFERENCES webhook_services(id) ON DELETE CASCADE,
  session_key text CHECK (session_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  harness text CHECK (harness ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  producer_key text CHECK (producer_key ~ '^[A-Za-z0-9._:-]{1,100}$'),
  CONSTRAINT works_producer_identity CHECK (CASE producer_type
    WHEN 'agent_session' THEN credential_id IS NOT NULL AND session_key IS NOT NULL AND harness IS NOT NULL
      AND service_id IS NULL AND producer_key IS NULL
    WHEN 'script' THEN credential_id IS NOT NULL AND producer_key IS NOT NULL
      AND service_id IS NULL AND session_key IS NULL AND harness IS NULL
    WHEN 'service' THEN service_id IS NOT NULL AND producer_key IS NOT NULL
      AND credential_id IS NULL AND session_key IS NULL AND harness IS NULL
  END),

  -- Declared lifecycle. "Left unfinished", "stale", "no signal" are derived, never stored.
  lifecycle text NOT NULL DEFAULT 'open' CHECK (lifecycle IN ('open','paused','finished','failed','dropped')),
  paused_reason text CHECK (paused_reason IN ('declared','parked')),
  CONSTRAINT works_paused_reason CHECK ((lifecycle = 'paused') = (paused_reason IS NOT NULL)),
  finished_at timestamptz,
  CONSTRAINT works_finished_at CHECK ((lifecycle IN ('finished','failed','dropped')) = (finished_at IS NOT NULL)),
  outcome_declared boolean NOT NULL DEFAULT false,
  CONSTRAINT works_outcome_required CHECK (lifecycle NOT IN ('finished','failed','dropped') OR outcome_declared),

  -- Declared text. NULL whenever sealed_text (the CLI sealed it for the owner's devices).
  sealed_text boolean NOT NULL DEFAULT false,
  goal text CHECK (goal IS NULL OR char_length(goal) BETWEEN 1 AND 120),
  status text CHECK (status IS NULL OR char_length(status) BETWEEN 1 AND 120),
  outcome text CHECK (outcome IS NULL OR char_length(outcome) BETWEEN 1 AND 200),
  waiting_reason text CHECK (waiting_reason IS NULL OR char_length(waiting_reason) BETWEEN 1 AND 60),
  waiting_since timestamptz,
  CONSTRAINT works_waiting CHECK (waiting_reason IS NULL OR waiting_since IS NOT NULL),
  CONSTRAINT works_sealed_text_only CHECK (NOT sealed_text
    OR (goal IS NULL AND status IS NULL AND outcome IS NULL AND waiting_reason IS NULL)),
  sealed jsonb,
  producer_sealed jsonb,

  -- Plan: {"v":1,"next":N,"steps":[{"id":"s1","state":"done","addedIn":1,"label"?:…,"progress"?:{done,total}}]}
  plan jsonb NOT NULL DEFAULT '{"v":1,"next":1,"steps":[]}'::jsonb,
  plan_version integer NOT NULL DEFAULT 1 CHECK (plan_version >= 1),
  CONSTRAINT works_plan_shape CHECK (jsonb_typeof(plan->'steps') = 'array'
    AND jsonb_array_length(plan->'steps') <= 30 AND (plan->>'v') = '1'),
  CONSTRAINT works_plan_sealed_labels CHECK (NOT sealed_text OR NOT jsonb_path_exists(plan,'$.steps[*].label')),
  progress_n integer,
  progress_m integer,
  CONSTRAINT works_progress CHECK ((progress_n IS NULL) = (progress_m IS NULL)
    AND (progress_m IS NULL OR (progress_m BETWEEN 1 AND 1000000 AND progress_n BETWEEN 0 AND progress_m))),

  -- Lease (2.11): scripts and services only.
  lease_until timestamptz,
  CONSTRAINT works_lease_type CHECK (lease_until IS NULL OR producer_type IN ('script','service')),

  context jsonb,
  source_name text CHECK (source_name IS NULL OR char_length(source_name) BETWEEN 1 AND 80),

  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  create_idempotency_key text CHECK (char_length(create_idempotency_key) BETWEEN 1 AND 200),
  create_request_hash text CHECK (create_request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- The evidence clock's declared half.
  declared_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

-- One open work per producer identity; others are parked.
CREATE UNIQUE INDEX works_one_open_per_session ON works (principal_id, session_key)
  WHERE lifecycle = 'open' AND producer_type = 'agent_session';
CREATE UNIQUE INDEX works_one_open_per_script ON works (credential_id, producer_key)
  WHERE lifecycle = 'open' AND producer_type = 'script';
CREATE UNIQUE INDEX works_one_open_per_service ON works (service_id, producer_key)
  WHERE lifecycle = 'open' AND producer_type = 'service';
CREATE UNIQUE INDEX works_create_idempotency_credential ON works (credential_id, create_idempotency_key)
  WHERE credential_id IS NOT NULL AND create_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX works_create_idempotency_service ON works (service_id, create_idempotency_key)
  WHERE service_id IS NOT NULL AND create_idempotency_key IS NOT NULL;
CREATE INDEX works_session_idx ON works (principal_id, session_key, updated_at DESC) WHERE session_key IS NOT NULL;
CREATE INDEX works_principal_recent_idx ON works (principal_id, updated_at DESC);

-- Idempotent write receipts: a retried write answers what the first did.
CREATE TABLE work_operations (
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('update','pause','resume','finish','heartbeat','question','notice')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (work_id, idempotency_key)
);

-- Cards are views of works: at most one active card per work.
ALTER TABLE live_activities ADD COLUMN work_id uuid REFERENCES works(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX live_activities_one_active_card_per_work ON live_activities (work_id)
  WHERE state = 'active' AND work_id IS NOT NULL;
CREATE INDEX live_activities_work_idx ON live_activities (work_id, created_at DESC) WHERE work_id IS NOT NULL;

GRANT SELECT,INSERT,UPDATE,DELETE ON works,work_operations TO relo_runtime;
