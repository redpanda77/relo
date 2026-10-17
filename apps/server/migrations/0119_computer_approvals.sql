-- Computers are approved once, on any trusted device (docs/ENCRYPTION-PROTOCOL.md): a phone, the Mac app or a
-- linked browser signs the computer's login id and current identity key. The server stores and lists the
-- signatures; every device verifies them against the approvers it trusts. One approval per computer key and
-- approver; a changed key needs a new one (old rows stop being listed: identity_key no longer matches).
CREATE TABLE computer_approvals (
  id bigserial PRIMARY KEY,
  api_key_id uuid NOT NULL REFERENCES principal_api_keys(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  identity_key text NOT NULL CHECK (identity_key ~ '^[A-Za-z0-9_-]{87}$'),
  approved_by_device uuid REFERENCES devices(id) ON DELETE CASCADE,
  approved_by_browser uuid REFERENCES linked_browsers(id) ON DELETE CASCADE,
  signed_at text NOT NULL,
  signature text NOT NULL CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  approved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT computer_approvals_one_approver CHECK ((approved_by_device IS NULL) <> (approved_by_browser IS NULL))
);
CREATE UNIQUE INDEX computer_approvals_by_device ON computer_approvals(api_key_id,identity_key,approved_by_device)
  WHERE approved_by_device IS NOT NULL;
CREATE UNIQUE INDEX computer_approvals_by_browser ON computer_approvals(api_key_id,identity_key,approved_by_browser)
  WHERE approved_by_browser IS NOT NULL;
CREATE INDEX computer_approvals_principal ON computer_approvals(principal_id);

GRANT SELECT,INSERT,UPDATE,DELETE ON computer_approvals TO relo_runtime;
GRANT USAGE,SELECT ON SEQUENCE computer_approvals_id_seq TO relo_runtime;
