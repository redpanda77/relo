GRANT SELECT,INSERT,UPDATE ON live_activity_presentation_leases TO relo_runtime;
REVOKE DELETE,TRUNCATE ON live_activity_presentation_leases FROM relo_runtime;

COMMENT ON TABLE live_activity_presentation_leases IS
  'Server-owned per-device presentation candidates and applied-state evidence; canonical activity lifecycle remains in live_activities.';
