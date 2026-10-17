-- A computer's sign-in carries the identity key it starts with (docs/ENCRYPTION-PROTOCOL.md, "Sign-in number"): the
-- approving device shows the number computed from it, and once the login is issued checks the computer published
-- that same key. The server relays the key and never judges it.
ALTER TABLE device_authorizations
  ADD COLUMN identity_key text CHECK (identity_key IS NULL OR identity_key ~ '^[A-Za-z0-9_-]{87}$'),
  ADD COLUMN issued_login_id uuid REFERENCES principal_api_keys(id) ON DELETE SET NULL;
