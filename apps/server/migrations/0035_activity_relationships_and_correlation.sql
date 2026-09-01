CREATE TABLE activity_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  predecessor_activity_id uuid NOT NULL REFERENCES live_activities(id) ON DELETE CASCADE,
  successor_activity_id uuid NOT NULL REFERENCES live_activities(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('continuation','supersession','companion')),
  actor text NOT NULL CHECK (actor IN ('cli','service','dashboard','reconciler','server','migration')),
  reason text NOT NULL CHECK (reason ~ '^[a-z0-9_]{1,64}$'),
  provenance text NOT NULL CHECK (provenance IN ('runtime','historical_exact','operator_resolution')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (predecessor_activity_id<>successor_activity_id),
  UNIQUE (principal_id,predecessor_activity_id,successor_activity_id,kind)
);

CREATE TABLE activity_correlation_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  activity_id uuid REFERENCES live_activities(id) ON DELETE CASCADE,
  relationship_id uuid REFERENCES activity_relationships(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN (
    'created','reused','resumed','blocked_ambiguous','blocked_conflict'
  )),
  matched_by text NOT NULL CHECK (matched_by IN (
    'origin','lifecycle','activity_key','explicit_id','current','replacement','parent','none','legacy_exact'
  )),
  actor text NOT NULL CHECK (actor IN ('cli','service','dashboard','reconciler','server','migration')),
  reason text NOT NULL CHECK (reason ~ '^[a-z0-9_]{1,64}$'),
  provenance text NOT NULL CHECK (provenance IN ('runtime','historical_exact','operator_resolution')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (outcome='blocked_ambiguous' AND activity_id IS NULL AND relationship_id IS NULL)
    OR outcome<>'blocked_ambiguous'
  ),
  CHECK (
    outcome IN ('blocked_ambiguous','blocked_conflict')
    OR activity_id IS NOT NULL
  )
);

CREATE INDEX activity_relationships_predecessor_idx
  ON activity_relationships(principal_id,predecessor_activity_id,created_at DESC,id DESC);
CREATE INDEX activity_relationships_successor_idx
  ON activity_relationships(principal_id,successor_activity_id,created_at DESC,id DESC);
CREATE INDEX activity_correlation_decisions_activity_idx
  ON activity_correlation_decisions(principal_id,activity_id,created_at DESC,id DESC);
CREATE INDEX activity_correlation_decisions_history_idx
  ON activity_correlation_decisions(principal_id,created_at DESC,id DESC);

CREATE FUNCTION enforce_activity_evidence_principal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  predecessor_principal uuid;
  successor_principal uuid;
  selected_principal uuid;
  relationship_principal uuid;
BEGIN
  IF TG_TABLE_NAME='activity_relationships' THEN
    SELECT principal_id INTO predecessor_principal
    FROM live_activities WHERE id=NEW.predecessor_activity_id;
    SELECT principal_id INTO successor_principal
    FROM live_activities WHERE id=NEW.successor_activity_id;
    IF predecessor_principal IS DISTINCT FROM NEW.principal_id
      OR successor_principal IS DISTINCT FROM NEW.principal_id THEN
      RAISE EXCEPTION 'activity relationship principal mismatch';
    END IF;
  ELSE
    IF NEW.activity_id IS NOT NULL THEN
      SELECT principal_id INTO selected_principal
      FROM live_activities WHERE id=NEW.activity_id;
      IF selected_principal IS DISTINCT FROM NEW.principal_id THEN
        RAISE EXCEPTION 'activity correlation principal mismatch';
      END IF;
    END IF;
    IF NEW.relationship_id IS NOT NULL THEN
      SELECT principal_id INTO relationship_principal
      FROM activity_relationships WHERE id=NEW.relationship_id;
      IF relationship_principal IS DISTINCT FROM NEW.principal_id THEN
        RAISE EXCEPTION 'activity correlation relationship principal mismatch';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER activity_relationships_principal_guard
BEFORE INSERT OR UPDATE ON activity_relationships
FOR EACH ROW EXECUTE FUNCTION enforce_activity_evidence_principal();

CREATE TRIGGER activity_correlation_decisions_principal_guard
BEFORE INSERT OR UPDATE ON activity_correlation_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_activity_evidence_principal();

CREATE FUNCTION reject_activity_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM owner_principals WHERE id=OLD.principal_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'activity relationship evidence is append-only';
END;
$$;

CREATE TRIGGER activity_relationships_no_update
BEFORE UPDATE ON activity_relationships
FOR EACH ROW EXECUTE FUNCTION reject_activity_evidence_mutation();
CREATE TRIGGER activity_relationships_no_delete
BEFORE DELETE ON activity_relationships
FOR EACH ROW EXECUTE FUNCTION reject_activity_evidence_mutation();
CREATE TRIGGER activity_correlation_decisions_no_update
BEFORE UPDATE ON activity_correlation_decisions
FOR EACH ROW EXECUTE FUNCTION reject_activity_evidence_mutation();
CREATE TRIGGER activity_correlation_decisions_no_delete
BEFORE DELETE ON activity_correlation_decisions
FOR EACH ROW EXECUTE FUNCTION reject_activity_evidence_mutation();

WITH exact_generations AS (
  SELECT activity.id,activity.principal_id,activity.origin_hash,activity.generation,
    lag(activity.id) OVER (
      PARTITION BY activity.principal_id,activity.origin_hash
      ORDER BY activity.generation,activity.created_at,activity.id
    ) AS predecessor_id
  FROM live_activities activity
  WHERE activity.origin_hash IS NOT NULL
)
INSERT INTO activity_relationships(
  principal_id,predecessor_activity_id,successor_activity_id,kind,actor,reason,provenance
)
SELECT principal_id,predecessor_id,id,'continuation','migration',
  'same_origin_generation','historical_exact'
FROM exact_generations
WHERE predecessor_id IS NOT NULL
ON CONFLICT DO NOTHING;

WITH exact_generations AS (
  SELECT activity.id,activity.principal_id,activity.origin_hash,
    lag(activity.id) OVER (
      PARTITION BY activity.principal_id,activity.origin_hash
      ORDER BY activity.generation,activity.created_at,activity.id
    ) AS predecessor_id
  FROM live_activities activity
  WHERE activity.origin_hash IS NOT NULL
)
INSERT INTO activity_correlation_decisions(
  principal_id,activity_id,outcome,matched_by,actor,reason,provenance,created_at
)
SELECT activity.principal_id,activity.id,
  CASE WHEN exact.predecessor_id IS NULL THEN 'created' ELSE 'resumed' END,
  CASE WHEN activity.origin_hash IS NULL THEN 'none' ELSE 'legacy_exact' END,
  'migration',
  CASE WHEN exact.predecessor_id IS NULL THEN 'historical_generation_created' ELSE 'same_origin_generation' END,
  'historical_exact',activity.created_at
FROM live_activities activity
LEFT JOIN exact_generations exact ON exact.id=activity.id
ORDER BY activity.created_at,activity.id;

GRANT SELECT,INSERT ON activity_relationships,activity_correlation_decisions TO relo_runtime;
REVOKE UPDATE,DELETE,TRUNCATE ON activity_relationships,activity_correlation_decisions FROM relo_runtime;

COMMENT ON TABLE activity_relationships IS
  'Immutable same-principal predecessor, successor, supersession, and companion activity edges.';
COMMENT ON TABLE activity_correlation_decisions IS
  'Append-only categorical lifecycle correlation outcomes without prompts, content, or private identifiers.';
