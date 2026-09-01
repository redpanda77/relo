CREATE TYPE live_activity_state AS ENUM ('active', 'ended');

CREATE TABLE live_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  activity_key text NOT NULL,
  title text NOT NULL,
  status text,
  detail text,
  progress double precision CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
  style text,
  privacy text NOT NULL DEFAULT 'standard' CHECK (privacy IN ('standard', 'private')),
  state live_activity_state NOT NULL DEFAULT 'active',
  sequence bigint NOT NULL DEFAULT 0,
  target_device_ids uuid[],
  start_idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (principal_id, activity_key),
  UNIQUE (principal_id, start_idempotency_key)
);

CREATE INDEX live_activities_principal_state_idx ON live_activities (principal_id, state, updated_at DESC);

CREATE TABLE live_activity_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_activity_id uuid NOT NULL REFERENCES live_activities(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('update', 'end')),
  resulting_sequence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (live_activity_id, idempotency_key)
);
