GRANT SELECT,INSERT,UPDATE ON connection_grants TO relo_runtime;
REVOKE DELETE,TRUNCATE ON connection_grants FROM relo_runtime;
