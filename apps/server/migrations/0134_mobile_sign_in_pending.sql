-- Browser sign-in from a Relo app on a server with Approval registration: the account waits for the admin, so the browser
-- hands the app a one-time pending ticket (only its hash is stored) bound to the app's PKCE challenge. The app polls with
-- the ticket and verifier and receives its phone account session once the account is approved.
-- No foreign key on subject: a declined request deletes the account, and the ticket must still answer "declined".
CREATE TABLE mobile_sign_in_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  ticket_hash text NOT NULL UNIQUE,
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  device text NOT NULL CHECK (device IN ('iphone','mac','windows')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  consumed_by_installation_id text,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_by_installation_id IS NOT NULL),
  -- One live ticket per account and app sign-in attempt: asking again replaces the earlier ticket.
  UNIQUE (subject, code_challenge)
);

CREATE INDEX mobile_sign_in_pending_expiry_idx ON mobile_sign_in_pending(expires_at);

GRANT SELECT,INSERT,UPDATE,DELETE ON mobile_sign_in_pending TO relo_runtime;
REVOKE TRUNCATE ON mobile_sign_in_pending FROM relo_runtime;
