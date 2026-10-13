-- New devices are approved on a trusted phone (docs/END-TO-END-ENCRYPTION.md): the approving phone's
-- signature over the new device's id and identity key. The server stores it and lists it with the
-- device's keys; computers decide whether to trust it. An approval covers one identity key only.
CREATE TABLE device_approvals (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  identity_key text NOT NULL CHECK (identity_key ~ '^[A-Za-z0-9_-]{87}$'),
  approved_by_device uuid REFERENCES devices(id) ON DELETE SET NULL,
  signed_at text NOT NULL,
  signature text NOT NULL CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  approved_at timestamptz NOT NULL DEFAULT now()
);

-- One "New device wants access" notice per device and identity key.
ALTER TABLE device_identity_keys ADD COLUMN approval_requested_at timestamptz;

GRANT SELECT,INSERT,UPDATE,DELETE ON device_approvals TO relo_runtime;
