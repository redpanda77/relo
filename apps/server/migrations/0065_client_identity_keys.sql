-- Each CLI credential's end-to-end encryption identity key (docs/END-TO-END-ENCRYPTION.md, E2.3).
-- Phones read these to show safety numbers and to recognise who sealed an envelope; trust is
-- decided on the phone by the owner, never by the server.
CREATE TABLE client_identity_keys (
  api_key_id uuid PRIMARY KEY REFERENCES principal_api_keys(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  key_id text NOT NULL CHECK (key_id ~ '^k_[A-Za-z0-9_-]{22}$'),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{87}$'),
  first_published_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX client_identity_keys_principal ON client_identity_keys(principal_id);

GRANT SELECT,INSERT,UPDATE,DELETE ON client_identity_keys TO relo_runtime;
