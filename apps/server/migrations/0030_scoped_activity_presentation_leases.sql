ALTER TABLE live_activity_presentation_leases
  ADD COLUMN scope_key text;

UPDATE live_activity_presentation_leases l
SET scope_key=COALESCE(
  CASE WHEN NULLIF(BTRIM(a.context->>'threadName'),'') IS NOT NULL THEN
    'thread:'||COALESCE(NULLIF(LOWER(BTRIM(a.context->>'project')),'')||':','')
      ||LOWER(BTRIM(a.context->>'threadName'))
  END,
  CASE WHEN NULLIF(BTRIM(a.context->>'project'),'') IS NOT NULL THEN
    'project:'||LOWER(BTRIM(a.context->>'project'))
  END,
  CASE WHEN a.conversation_id IS NOT NULL THEN 'conversation:'||a.conversation_id::text END,
  CASE WHEN a.origin_hash IS NOT NULL THEN 'origin:'||a.origin_hash END,
  'activity:'||a.id::text
)
FROM live_activities a
WHERE a.id=l.live_activity_id;

ALTER TABLE live_activity_presentation_leases
  ALTER COLUMN scope_key SET NOT NULL;

DROP INDEX live_activity_presentation_leases_foreground_device_idx;

CREATE UNIQUE INDEX live_activity_presentation_leases_foreground_scope_idx
  ON live_activity_presentation_leases(principal_id,device_id,scope_key)
  WHERE state='foreground';

COMMENT ON COLUMN live_activity_presentation_leases.scope_key IS
  'Normalized thread, project, conversation, origin, or activity scope used for per-device foreground arbitration.';
