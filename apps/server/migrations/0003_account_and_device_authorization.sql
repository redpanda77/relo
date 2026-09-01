CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth.users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.sessions (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE INDEX auth_sessions_user_idx ON auth.sessions(user_id);

CREATE TABLE auth.accounts (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_accounts_user_idx ON auth.accounts(user_id);

CREATE TABLE auth.verifications (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verifications_identifier_idx ON auth.verifications(identifier);

CREATE TABLE account_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL UNIQUE REFERENCES owner_principals(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'better-auth',
  subject text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, subject)
);

ALTER TABLE principal_api_keys
  ADD COLUMN token_prefix text NOT NULL DEFAULT 'relo_legacy',
  ADD COLUMN expires_at timestamptz;

ALTER TABLE devices
  ADD COLUMN credential_version integer NOT NULL DEFAULT 0;

CREATE TABLE device_registration_idempotency (
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(principal_id, idempotency_key)
);

CREATE TABLE device_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE,
  user_code text NOT NULL UNIQUE,
  client_name text NOT NULL,
  requested_scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','expired','consumed')),
  approved_owner_id uuid REFERENCES owner_principals(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  credential_expires_at timestamptz NOT NULL,
  poll_interval_seconds integer NOT NULL DEFAULT 5 CHECK (poll_interval_seconds BETWEEN 5 AND 30),
  last_poll_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  consumed_at timestamptz
);
CREATE INDEX device_authorizations_cleanup_idx ON device_authorizations(status, expires_at);
CREATE INDEX device_authorizations_owner_idx ON device_authorizations(approved_owner_id)
  WHERE approved_owner_id IS NOT NULL;

CREATE TABLE webhook_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  title text NOT NULL,
  image_url text,
  default_url text,
  secret_hash text NOT NULL UNIQUE,
  secret_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX webhook_services_principal_idx ON webhook_services(principal_id, created_at DESC);

ALTER TABLE notification_events
  ADD COLUMN service_id uuid REFERENCES webhook_services(id) ON DELETE SET NULL;
