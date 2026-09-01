CREATE TABLE runtime_components (
  component text PRIMARY KEY CHECK (component IN ('worker')),
  release_identity text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(details) = 'object')
);

GRANT SELECT,INSERT,UPDATE ON runtime_components TO relo_runtime;

COMMENT ON TABLE runtime_components IS
  'Small runtime liveness registry used by the installation doctor; it is not delivery evidence.';
