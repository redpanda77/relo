GRANT SELECT ON schema_migrations TO relo_runtime;

COMMENT ON TABLE schema_migrations IS
  'Applied migration identities; readable by the runtime role for installation readiness checks.';
