-- Add a computer (docs/site/guides/servers.md): a trusted device (a phone, the Mac app, a signed-in browser or
-- computer) makes a one-time code; the new computer redeems it for its own login, with no browser sign-in. Only the
-- code's hash is kept; a code works once, for 30 minutes. The new computer is still a computer every device decides
-- on (docs/ENCRYPTION-PROTOCOL.md, "Computers are approved once").
CREATE TABLE computer_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  -- Who made it, for the owner's list: "phone", "mac", "browser" or "computer", and its name.
  issued_by_kind text NOT NULL CHECK (issued_by_kind IN ('phone','mac','browser','computer')),
  issued_by_name text NOT NULL,
  -- How deep relo setup goes on the new computer, as the owner chose it ("track", "guide" or "optimize").
  setup_level text NOT NULL DEFAULT 'guide' CHECK (setup_level IN ('notify','track','guide','optimize')),
  setup_approvals boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_login_id uuid REFERENCES principal_api_keys(id) ON DELETE SET NULL
);
CREATE INDEX computer_invites_principal ON computer_invites(principal_id,created_at DESC);

GRANT SELECT,INSERT,UPDATE,DELETE ON computer_invites TO relo_runtime;
