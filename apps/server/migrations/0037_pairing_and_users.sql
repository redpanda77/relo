ALTER TABLE account_identities DROP CONSTRAINT IF EXISTS account_identities_principal_id_key;
ALTER TABLE account_identities
  ADD COLUMN role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','member')),
  ADD COLUMN disabled_at timestamptz;

CREATE INDEX account_identities_principal_idx
  ON account_identities(principal_id, created_at DESC);

CREATE TABLE connection_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  created_by_subject text NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  grant_hash text NOT NULL UNIQUE,
  grant_prefix text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  consumed_by_installation_id text,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_by_installation_id IS NOT NULL)
);

CREATE INDEX connection_grants_principal_idx
  ON connection_grants(principal_id, created_at DESC);

CREATE UNIQUE INDEX connection_grants_installation_replay_idx
  ON connection_grants(id, consumed_by_installation_id)
  WHERE consumed_at IS NOT NULL;

ALTER TABLE devices
  ADD COLUMN registered_by_subject text REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX devices_registered_by_subject_idx
  ON devices(principal_id, registered_by_subject) WHERE revoked_at IS NULL;
