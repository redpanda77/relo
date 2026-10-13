-- Native chronology survives notification retention and never renews on command replay.
CREATE TABLE activity_mutation_freshness (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES live_activities(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  operation text NOT NULL CHECK (operation IN ('start','update','end')),
  occurred_at timestamptz,
  accepted_at timestamptz NOT NULL,
  deliver_until timestamptz NOT NULL,
  UNIQUE (activity_id, sequence)
);
ALTER TABLE notification_events ADD COLUMN activity_mutation_id uuid
  REFERENCES activity_mutation_freshness(id) ON DELETE RESTRICT;
-- No inferred original occurrence or fresh delivery window for pre-cutover rows.
GRANT SELECT,INSERT ON activity_mutation_freshness TO relo_runtime;
REVOKE UPDATE,DELETE ON activity_mutation_freshness FROM relo_runtime;
