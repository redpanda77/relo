-- Browser sign-in for the iPhone: the owner approves in the web app, which issues a one-time code
-- bound to the app's PKCE challenge. Only the code's hash is stored.
CREATE TABLE mobile_sign_in_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  subject text NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  consumed_by_installation_id text,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_by_installation_id IS NOT NULL)
);

CREATE INDEX mobile_sign_in_codes_expiry_idx ON mobile_sign_in_codes(expires_at);

GRANT SELECT,INSERT,UPDATE ON mobile_sign_in_codes TO relo_runtime;
REVOKE DELETE,TRUNCATE ON mobile_sign_in_codes FROM relo_runtime;
