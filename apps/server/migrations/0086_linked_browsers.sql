-- Linked browsers (docs/END-TO-END-ENCRYPTION.md, "Linked browsers"): a web Dashboard that holds its
-- own non-extractable keys and reads sealed content once a trusted phone has signed its identity key
-- (scanned from a QR code). Public halves and the phone's signature only; the server holds no key
-- that opens anything and cannot link a browser itself: computers check the phone's signature.
CREATE TABLE linked_browsers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  key_id text NOT NULL CHECK (key_id ~ '^k_[A-Za-z0-9_-]{22}$'),
  identity_key text NOT NULL CHECK (identity_key ~ '^[A-Za-z0-9_-]{87}$'),
  prekey_id text NOT NULL CHECK (prekey_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  prekey_public_key text NOT NULL CHECK (prekey_public_key ~ '^[A-Za-z0-9_-]{87}$'),
  prekey_signature text NOT NULL CHECK (prekey_signature ~ '^[A-Za-z0-9_-]{86}$'),
  prekey_created_at text NOT NULL,
  prekey_received_at timestamptz NOT NULL DEFAULT now(),
  linked_by_device uuid REFERENCES devices(id) ON DELETE SET NULL,
  link_signed_at text,
  link_signature text CHECK (link_signature IS NULL OR link_signature ~ '^[A-Za-z0-9_-]{86}$'),
  linked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX linked_browsers_principal ON linked_browsers(principal_id) WHERE revoked_at IS NULL;

GRANT SELECT,INSERT,UPDATE,DELETE ON linked_browsers TO relo_runtime;
