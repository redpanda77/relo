-- E1.2: the scheduled retention window also removes ended cards (title, status, steps, presentation
-- and operation snapshots) once their events are gone. Active cards are never touched (they also
-- stay protected by refuse_active_activity_deletion), and a card is kept while any of its events
-- remains, because events reference its mutations.
DROP FUNCTION run_scheduled_content_retention(integer,text);

CREATE FUNCTION run_scheduled_content_retention(
  retention_hours integer,
  operation_release_identity text
) RETURNS TABLE(run_id uuid,events_pruned integer,tombstones_expired integer,cards_pruned integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  cutoff timestamptz;
  notification_run record;
  card_count integer := 0;
BEGIN
  IF retention_hours IS NULL OR retention_hours<1 OR retention_hours>8760 THEN
    RAISE EXCEPTION 'invalid content retention window';
  END IF;
  cutoff := now()-make_interval(hours => retention_hours);
  SELECT * INTO notification_run FROM run_notification_retention(
    cutoff,2147483647,200,interval '90 days',operation_release_identity
  );
  WITH expired AS (
    SELECT activity.id FROM live_activities activity
    WHERE activity.state<>'active' AND COALESCE(activity.ended_at,activity.updated_at)<cutoff
      AND NOT EXISTS (
        SELECT 1 FROM activity_mutation_freshness mutation
        JOIN notification_events event ON event.activity_mutation_id=mutation.id
        WHERE mutation.activity_id=activity.id
      )
    ORDER BY COALESCE(activity.ended_at,activity.updated_at),activity.id
    LIMIT 200
    FOR UPDATE OF activity SKIP LOCKED
  )
  DELETE FROM live_activities WHERE id IN (SELECT id FROM expired);
  GET DIAGNOSTICS card_count = ROW_COUNT;
  RETURN QUERY SELECT notification_run.run_id,notification_run.events_pruned,
    notification_run.tombstones_expired,card_count;
END;
$$;

REVOKE ALL ON FUNCTION run_scheduled_content_retention(integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_scheduled_content_retention(integer,text) TO relo_runtime;
