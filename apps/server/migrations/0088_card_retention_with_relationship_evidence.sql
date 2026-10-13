-- Scheduled retention deletes ended cards past the window (0069). A card's relationship and
-- correlation evidence is append-only (0035) except when its account is deleted, so deleting a
-- card that had evidence failed every cycle ("activity relationship evidence is append-only").
-- Evidence about a card whose content retention removed has nothing left to describe: retention,
-- and only retention, deletes it with the card, the same way 0025 lifts the delivery-attempt guard
-- for the events it prunes. Every other path keeps the evidence append-only.
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
  expired_ids uuid[];
BEGIN
  IF retention_hours IS NULL OR retention_hours<1 OR retention_hours>8760 THEN
    RAISE EXCEPTION 'invalid content retention window';
  END IF;
  cutoff := now()-make_interval(hours => retention_hours);
  SELECT * INTO notification_run FROM run_notification_retention(
    cutoff,2147483647,200,interval '90 days',operation_release_identity
  );
  SELECT array_agg(expired.id) INTO expired_ids FROM (
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
  ) expired;
  IF COALESCE(cardinality(expired_ids),0)>0 THEN
    ALTER TABLE activity_relationships DISABLE TRIGGER activity_relationships_no_delete;
    ALTER TABLE activity_correlation_decisions DISABLE TRIGGER activity_correlation_decisions_no_delete;
    -- A surviving decision that pointed at removed evidence loses only that pointer (ON DELETE SET NULL).
    ALTER TABLE activity_correlation_decisions DISABLE TRIGGER activity_correlation_decisions_no_update;
    DELETE FROM live_activities WHERE id=ANY(expired_ids);
    GET DIAGNOSTICS card_count = ROW_COUNT;
    ALTER TABLE activity_correlation_decisions ENABLE TRIGGER activity_correlation_decisions_no_update;
    ALTER TABLE activity_correlation_decisions ENABLE TRIGGER activity_correlation_decisions_no_delete;
    ALTER TABLE activity_relationships ENABLE TRIGGER activity_relationships_no_delete;
  END IF;
  RETURN QUERY SELECT notification_run.run_id,notification_run.events_pruned,
    notification_run.tombstones_expired,card_count;
END;
$$;

REVOKE ALL ON FUNCTION run_scheduled_content_retention(integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_scheduled_content_retention(integer,text) TO relo_runtime;
