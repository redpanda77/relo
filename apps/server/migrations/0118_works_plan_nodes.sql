-- Plans hold rounds and nested steps (ADR 0012): up to 120 steps per work (WORK_PLAN_MAX_NODES), 30 per
-- round. 0099 still capped the array at 30, so a work's 31st step failed with works_plan_shape (16 October).
ALTER TABLE works DROP CONSTRAINT works_plan_shape;
ALTER TABLE works ADD CONSTRAINT works_plan_shape CHECK (jsonb_typeof(plan->'steps') = 'array'
  AND jsonb_array_length(plan->'steps') <= 120 AND (plan->>'v') = '1');
