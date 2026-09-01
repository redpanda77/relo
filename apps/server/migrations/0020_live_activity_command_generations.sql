ALTER TABLE live_activity_update_tokens
  ADD COLUMN generation integer;

UPDATE live_activity_update_tokens token
SET generation=activity.generation
FROM live_activities activity
WHERE activity.id=token.live_activity_id;

ALTER TABLE live_activity_update_tokens
  ALTER COLUMN generation SET NOT NULL,
  ADD CONSTRAINT live_activity_update_tokens_generation_positive CHECK (generation > 0);

UPDATE notification_events event
SET payload=jsonb_set(event.payload,'{liveActivity,generation}',to_jsonb(activity.generation),true)
FROM live_activities activity
WHERE event.payload ? 'liveActivity'
  AND NOT (event.payload->'liveActivity' ? 'generation')
  AND event.payload#>>'{liveActivity,activityId}'='act_'||activity.id::text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM notification_events event
    WHERE event.payload ? 'liveActivity'
      AND NOT (event.payload->'liveActivity' ? 'generation')
  ) THEN
    RAISE EXCEPTION 'legacy Live Activity command could not be bound to a generation';
  END IF;
END $$;
