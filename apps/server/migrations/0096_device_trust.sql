-- Device trust in the Dashboard (docs/END-TO-END-ENCRYPTION.md).
-- 1. Simulators: the phone says so (isSimulator), or its model is a Mac architecture. A simulator is
--    labelled "Simulator", never gets device-approval notices, and never counts as the older device
--    that can approve a real phone.
ALTER TABLE devices ADD COLUMN is_simulator boolean NOT NULL DEFAULT false;
UPDATE devices SET is_simulator=true WHERE model IN ('arm64','x86_64','i386');

-- 2. A linked browser may approve a new phone: its identity key signs the same approve-device input a
--    phone signs. Exactly one approver is recorded; computers verify the signature themselves.
ALTER TABLE device_approvals ADD COLUMN approved_by_browser uuid REFERENCES linked_browsers(id) ON DELETE SET NULL;
ALTER TABLE device_approvals ADD CONSTRAINT device_approvals_one_approver
  CHECK (approved_by_device IS NULL OR approved_by_browser IS NULL);
