CREATE TABLE owner_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle text NOT NULL UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE principal_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY[
    'notifications:send','interactions:create','interactions:read',
    'activities:write','activities:read','devices:pair','devices:read','services:write'
  ]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX principal_api_keys_owner_label_idx ON principal_api_keys (principal_id, label);

CREATE TYPE apns_environment AS ENUM ('sandbox', 'production');
CREATE TYPE authorization_state AS ENUM ('unknown', 'denied', 'provisional', 'authorized');

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  stable_device_id text NOT NULL,
  installation_id text NOT NULL,
  name text NOT NULL,
  platform text NOT NULL DEFAULT 'ios' CHECK (platform = 'ios'),
  bundle_identifier text NOT NULL,
  app_version text NOT NULL,
  app_build text NOT NULL,
  os_version text NOT NULL,
  model text,
  apns_environment apns_environment NOT NULL,
  apns_token text,
  live_activity_push_to_start_token text,
  notification_authorization authorization_state NOT NULL DEFAULT 'unknown',
  live_activity_authorization authorization_state NOT NULL DEFAULT 'unknown',
  live_activity_schema_version integer NOT NULL DEFAULT 0,
  interaction_capability_version integer NOT NULL DEFAULT 0,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (principal_id, stable_device_id, installation_id)
);

CREATE INDEX devices_active_principal_idx
  ON devices (principal_id, last_seen_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE device_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['device:self','inbox:read','interactions:respond']::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

CREATE INDEX pairing_codes_active_idx ON pairing_codes (expires_at) WHERE consumed_at IS NULL;

CREATE TYPE notification_kind AS ENUM ('notification', 'approval', 'question', 'live_activity');
CREATE TYPE notification_state AS ENUM ('active', 'responded', 'expired', 'canceled');

CREATE TABLE notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  source text NOT NULL,
  kind notification_kind NOT NULL DEFAULT 'notification',
  title text NOT NULL,
  body text NOT NULL,
  image_url text,
  deep_link text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  state notification_state NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id, idempotency_key)
);

CREATE INDEX notification_events_inbox_idx
  ON notification_events (principal_id, updated_at ASC, id ASC);

CREATE TYPE delivery_state AS ENUM ('pending', 'processing', 'accepted', 'retry', 'permanently_failed', 'canceled');

CREATE TABLE delivery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_event_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  state delivery_state NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  provider_message_id text,
  last_error_code text,
  last_error_message text,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_event_id, device_id)
);

CREATE INDEX delivery_jobs_claim_idx
  ON delivery_jobs (available_at, created_at)
  WHERE state IN ('pending', 'retry');

CREATE TYPE interaction_request_kind AS ENUM ('approval', 'yes_no', 'text');
CREATE TYPE interaction_request_state AS ENUM ('pending', 'approved', 'denied', 'yes', 'no', 'replied', 'expired', 'canceled');

CREATE TABLE interaction_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  notification_event_id uuid NOT NULL UNIQUE REFERENCES notification_events(id) ON DELETE CASCADE,
  kind interaction_request_kind NOT NULL,
  prompt text NOT NULL,
  state interaction_request_state NOT NULL DEFAULT 'pending',
  response_token_hash text NOT NULL UNIQUE,
  response jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz
);

CREATE TYPE interaction_kind AS ENUM ('approve', 'deny', 'yes', 'no', 'answer', 'opened', 'received');

CREATE TABLE interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  notification_event_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  interaction_request_id uuid REFERENCES interaction_requests(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind interaction_kind NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id, idempotency_key)
);

CREATE INDEX interactions_event_idx ON interactions (notification_event_id, created_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
