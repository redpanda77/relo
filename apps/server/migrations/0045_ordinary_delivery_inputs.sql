ALTER TABLE delivery_jobs ADD COLUMN ordinary_delivery_inputs jsonb;

ALTER TABLE delivery_jobs ADD CONSTRAINT delivery_jobs_ordinary_inputs_check CHECK (
  ordinary_delivery_inputs IS NULL OR (
    jsonb_typeof(ordinary_delivery_inputs)='object'
    AND ordinary_delivery_inputs ? 'badge' AND ordinary_delivery_inputs ? 'avatarUrl'
    AND jsonb_typeof(ordinary_delivery_inputs->'badge')='number'
    AND (ordinary_delivery_inputs->>'badge') ~ '^[0-9]+$'
    AND (ordinary_delivery_inputs->>'badge')::numeric BETWEEN 0 AND 2147483647
    AND jsonb_typeof(ordinary_delivery_inputs->'avatarUrl') IN ('null','string')
  )
);

COMMENT ON COLUMN delivery_jobs.ordinary_delivery_inputs IS
  'Immutable ordinary-notification badge/avatar inputs captured before first payload pin. No device tokens or response capabilities. Existing hashes are never reset to reconstruct missing inputs.';
