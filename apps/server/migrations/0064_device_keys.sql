-- End-to-end encryption key directory (docs/END-TO-END-ENCRYPTION.md, E2.2). Public halves only:
-- the server relays keys and never holds a private key that opens content. Trust is decided by
-- each CLI's own trust store; the server checks only that a prekey is signed by its device.
CREATE TABLE device_identity_keys (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  key_id text NOT NULL CHECK (key_id ~ '^k_[A-Za-z0-9_-]{22}$'),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{87}$'),
  first_published_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_prekeys (
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  prekey_id text NOT NULL CHECK (prekey_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{87}$'),
  signature text NOT NULL CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  signed_created_at text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id,prekey_id)
);

CREATE INDEX device_prekeys_newest ON device_prekeys(device_id,received_at DESC);
CREATE INDEX device_identity_keys_principal ON device_identity_keys(principal_id);

GRANT SELECT,INSERT,UPDATE,DELETE ON device_identity_keys,device_prekeys TO relo_runtime;
