CREATE TABLE request_rate_limits (
  scope_kind text NOT NULL CHECK (scope_kind IN ('account','client','device','service')),
  scope_id uuid NOT NULL,
  family text NOT NULL CHECK (char_length(family) BETWEEN 1 AND 80),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_kind,scope_id,family)
);

CREATE INDEX request_rate_limits_updated_at_idx ON request_rate_limits(updated_at);
