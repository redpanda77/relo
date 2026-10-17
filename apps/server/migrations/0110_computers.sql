-- Computers (ADR 0011): one per login credential. The appearance the owner chose and the machine's own
-- report live here, never on principal_api_keys (which also holds CI tokens). A re-login upserts the same
-- credential row, so the computer survives it.
CREATE TABLE computers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  login_key_id uuid NOT NULL UNIQUE REFERENCES principal_api_keys(id) ON DELETE CASCADE,
  display_name text CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 80),
  icon text CHECK (icon IS NULL OR icon IN ('laptop','desktop','server','cloud','terminal','build')),
  report jsonb,
  report_hash text,
  reported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX computers_principal_idx ON computers(principal_id);
ALTER TABLE harness_credentials ADD COLUMN computer_id uuid REFERENCES computers(id) ON DELETE SET NULL;
INSERT INTO computers(principal_id, login_key_id)
  SELECT principal_id, id FROM principal_api_keys WHERE kind = 'login';
UPDATE harness_credentials h SET computer_id = c.id
  FROM computers c WHERE c.login_key_id = h.created_by_key_id;
GRANT SELECT, INSERT, UPDATE, DELETE ON computers TO relo_runtime;
