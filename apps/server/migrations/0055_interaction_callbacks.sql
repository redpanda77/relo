-- At-least-once answer delivery to a caller-supplied HTTPS endpoint.
-- A callback waits until its request is answered; expiry or cancel never calls back.
CREATE TABLE interaction_callbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  interaction_request_id uuid NOT NULL UNIQUE REFERENCES interaction_requests(id) ON DELETE CASCADE,
  url text NOT NULL CHECK (char_length(url) <= 2048 AND url LIKE 'https://%'),
  -- Encrypted with the transport-token key; never returned by any API.
  token_ciphertext text NOT NULL,
  correlation_id text CHECK (correlation_id IS NULL OR char_length(correlation_id) <= 100),
  state text NOT NULL DEFAULT 'waiting'
    CHECK (state IN ('waiting','pending','delivering','delivered','failed','not_answered')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  next_attempt_at timestamptz,
  lease_expires_at timestamptz,
  last_status integer,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX interaction_callbacks_due ON interaction_callbacks(next_attempt_at)
  WHERE state IN ('pending','delivering');
CREATE INDEX interaction_callbacks_waiting ON interaction_callbacks(interaction_request_id)
  WHERE state='waiting';
GRANT SELECT,INSERT,UPDATE ON interaction_callbacks TO relo_runtime;
