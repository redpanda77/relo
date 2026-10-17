-- Handoff (the working layer): a session hands its open work to a fresh session on the same computer.
-- Only the hash of the single-use handle is stored; one live row per work (a new handoff replaces it).
CREATE TABLE work_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  -- The login (computer) credential the work's session used; only the same one can take over.
  credential_id uuid NOT NULL REFERENCES principal_api_keys(id) ON DELETE CASCADE,
  handle_hash text NOT NULL CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT work_handoffs_one_per_work UNIQUE (work_id),
  CONSTRAINT work_handoffs_hash_unique UNIQUE (handle_hash)
);
