-- CI tokens (plan 10 A1): a login made by the owner for a pipeline or container, without a browser sign-in. It
-- shares the login table and its scopes, but always expires, never replaces a sign-in with the same name, and
-- records which login made it.
ALTER TABLE principal_api_keys ADD COLUMN kind text NOT NULL DEFAULT 'login' CHECK (kind IN ('login','ci-token'));
ALTER TABLE principal_api_keys ADD COLUMN created_by_key_id uuid REFERENCES principal_api_keys(id) ON DELETE SET NULL;
ALTER TABLE principal_api_keys ADD CONSTRAINT principal_api_keys_ci_token_expires
  CHECK (kind <> 'ci-token' OR expires_at IS NOT NULL);
