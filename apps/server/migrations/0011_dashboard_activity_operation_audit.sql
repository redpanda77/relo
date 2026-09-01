ALTER TABLE live_activity_operations
  DROP CONSTRAINT IF EXISTS live_activity_operations_operation_check;

ALTER TABLE live_activity_operations
  ADD CONSTRAINT live_activity_operations_operation_check
  CHECK (operation IN ('start','update','wait','respond','end'));

ALTER TABLE live_activity_operations
  ADD COLUMN companion_activity_id uuid REFERENCES live_activities(id) ON DELETE SET NULL;

CREATE INDEX live_activity_operations_companion_idx
  ON live_activity_operations(companion_activity_id)
  WHERE companion_activity_id IS NOT NULL;
