-- The worker deletes content past the owner-configured window (RELO_CONTENT_RETENTION_HOURS).
-- The runtime role may only start this bounded run: the cutoff is an age in hours, the batch is
-- fixed, and run_notification_retention keeps every pending decision, active card and current
-- relevance head. The general schema-owner function stays revoked from the runtime role.
CREATE FUNCTION run_scheduled_content_retention(
  retention_hours integer,
  operation_release_identity text
) RETURNS TABLE(run_id uuid,events_pruned integer,tombstones_expired integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
BEGIN
  IF retention_hours IS NULL OR retention_hours<1 OR retention_hours>8760 THEN
    RAISE EXCEPTION 'invalid content retention window';
  END IF;
  RETURN QUERY SELECT * FROM run_notification_retention(
    now()-make_interval(hours => retention_hours),
    2147483647,
    200,
    interval '90 days',
    operation_release_identity
  );
END;
$$;

REVOKE ALL ON FUNCTION run_scheduled_content_retention(integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_scheduled_content_retention(integer,text) TO relo_runtime;

COMMENT ON FUNCTION run_scheduled_content_retention(integer,text) IS
  'Bounded, worker-callable notification content retention; see docs/END-TO-END-ENCRYPTION.md (E1.1).';
