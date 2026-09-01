ALTER TABLE live_activities
  ADD COLUMN generation integer;

-- Existing activities predate generations. They are the first retained run for
-- their origin (or the fixed legacy generation for callers without an origin).
UPDATE live_activities
SET generation=1,
    start_snapshot=CASE
      WHEN start_snapshot IS NULL OR jsonb_typeof(start_snapshot)<>'object' THEN start_snapshot
      ELSE jsonb_set(start_snapshot,'{generation}','1'::jsonb,true)
    END;

UPDATE live_activity_operations
SET activity_snapshot=jsonb_set(activity_snapshot,'{generation}','1'::jsonb,true)
WHERE activity_snapshot IS NOT NULL AND jsonb_typeof(activity_snapshot)='object';

ALTER TABLE live_activities
  ALTER COLUMN generation SET DEFAULT 1,
  ALTER COLUMN generation SET NOT NULL,
  ADD CONSTRAINT live_activities_generation_positive CHECK (generation>0);

DROP INDEX live_activities_origin_slot_idx;

-- The database, not route timing, is the final authority for one active run.
CREATE UNIQUE INDEX live_activities_active_origin_slot_idx
  ON live_activities(principal_id,origin_hash)
  WHERE origin_hash IS NOT NULL AND state='active';

CREATE UNIQUE INDEX live_activities_origin_generation_idx
  ON live_activities(principal_id,origin_hash,generation)
  WHERE origin_hash IS NOT NULL;

CREATE INDEX live_activities_origin_history_idx
  ON live_activities(principal_id,origin_hash,generation DESC,created_at DESC,id DESC)
  WHERE origin_hash IS NOT NULL;
