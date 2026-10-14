-- Two-step sign-in (docs/HARDENING.md, gap 1): an authenticator app's codes and one-time backup
-- codes, stored by better-auth's two-factor plugin. The secret and backup codes are encrypted with
-- the auth secret by the plugin; the server never stores them readable.
ALTER TABLE auth.users ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE auth.two_factors (
  id text PRIMARY KEY,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id text NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  verified boolean NOT NULL DEFAULT true,
  failed_verification_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);
CREATE INDEX auth_two_factors_user_idx ON auth.two_factors(user_id);
CREATE INDEX auth_two_factors_secret_idx ON auth.two_factors(secret);

GRANT SELECT,INSERT,UPDATE,DELETE ON auth.two_factors TO relo_runtime;
