CREATE TABLE notification_idempotency_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  requester_kind text NOT NULL CHECK (requester_kind IN ('account','credential','service')),
  requester_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text,
  original_event_id uuid NOT NULL,
  pruned_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (requester_kind,requester_id,idempotency_key)
);

CREATE INDEX notification_idempotency_tombstones_expiry_idx
  ON notification_idempotency_tombstones(expires_at,id);

CREATE TABLE notification_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_identity text NOT NULL,
  cutoff_at timestamptz NOT NULL,
  maximum_events_per_principal integer NOT NULL,
  batch_size integer NOT NULL,
  events_pruned integer NOT NULL,
  tombstones_expired integer NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION reject_notification_retention_run_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notification_retention_runs rows are append-only';
END;
$$;

CREATE TRIGGER notification_retention_runs_no_update
BEFORE UPDATE ON notification_retention_runs
FOR EACH ROW EXECUTE FUNCTION reject_notification_retention_run_mutation();

CREATE TRIGGER notification_retention_runs_no_delete
BEFORE DELETE ON notification_retention_runs
FOR EACH ROW EXECUTE FUNCTION reject_notification_retention_run_mutation();

CREATE VIEW notification_retention_eligibility AS
WITH ranked AS (
  SELECT event.id,
    row_number() OVER (
      PARTITION BY event.principal_id
      ORDER BY event.created_at DESC,event.id DESC
    )::integer AS history_rank
  FROM notification_events event
)
SELECT event.id,event.principal_id,event.created_at,ranked.history_rank,
  NOT EXISTS (
    SELECT 1 FROM delivery_jobs job
    WHERE job.notification_event_id=event.id
      AND job.state IN ('pending','processing','retry','reconciliation_required')
  )
  AND NOT EXISTS (
    SELECT 1 FROM interaction_requests request
    WHERE request.notification_event_id=event.id AND request.state='pending'
  )
  AND NOT EXISTS (
    SELECT 1 FROM live_activities activity
    WHERE activity.principal_id=event.principal_id AND activity.state='active'
      AND event.payload#>>'{liveActivity,activityId}'='act_'||activity.id::text
  ) AS terminal_eligible
FROM notification_events event
JOIN ranked ON ranked.id=event.id;

CREATE FUNCTION prevent_pruned_notification_replay() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  replay_requester_kind text;
  replay_requester_id uuid;
BEGIN
  replay_requester_kind := CASE
    WHEN NEW.requester_credential_id IS NOT NULL THEN 'credential'
    WHEN NEW.requester_service_id IS NOT NULL THEN 'service'
    ELSE 'account'
  END;
  replay_requester_id := COALESCE(
    NEW.requester_credential_id,NEW.requester_service_id,NEW.principal_id
  );
  IF EXISTS (
    SELECT 1 FROM notification_idempotency_tombstones tombstone
    WHERE tombstone.requester_kind=replay_requester_kind
      AND tombstone.requester_id=replay_requester_id
      AND tombstone.idempotency_key=NEW.idempotency_key
      AND tombstone.expires_at>now()
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_events_pruned_replay_guard
BEFORE INSERT ON notification_events
FOR EACH ROW EXECUTE FUNCTION prevent_pruned_notification_replay();

CREATE FUNCTION run_notification_retention(
  retention_cutoff timestamptz,
  maximum_events_per_principal integer,
  retention_batch_size integer,
  tombstone_retention interval,
  operation_release_identity text
) RETURNS TABLE(run_id uuid,events_pruned integer,tombstones_expired integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  candidate_ids uuid[];
  pruned_count integer := 0;
  expired_count integer := 0;
  recorded_run_id uuid;
BEGIN
  IF retention_cutoff IS NULL OR retention_cutoff>now()
    OR maximum_events_per_principal<1
    OR retention_batch_size<1 OR retention_batch_size>5000
    OR tombstone_retention<interval '1 day'
    OR operation_release_identity !~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$' THEN
    RAISE EXCEPTION 'invalid notification retention parameters';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('relo:notification-retention:v1'));

  SELECT array_agg(candidate.id ORDER BY candidate.created_at,candidate.id)
  INTO candidate_ids
  FROM (
    SELECT event.id,event.created_at
    FROM notification_events event
    JOIN notification_retention_eligibility eligibility ON eligibility.id=event.id
    WHERE eligibility.terminal_eligible
      AND (
        eligibility.created_at<retention_cutoff
        OR eligibility.history_rank>maximum_events_per_principal
      )
    ORDER BY event.created_at,event.id
    LIMIT retention_batch_size
    FOR UPDATE OF event SKIP LOCKED
  ) candidate;

  IF COALESCE(cardinality(candidate_ids),0)>0 THEN
    INSERT INTO notification_idempotency_tombstones(
      principal_id,requester_kind,requester_id,idempotency_key,request_hash,
      original_event_id,expires_at
    )
    SELECT event.principal_id,
      CASE
        WHEN event.requester_credential_id IS NOT NULL THEN 'credential'
        WHEN event.requester_service_id IS NOT NULL THEN 'service'
        ELSE 'account'
      END,
      COALESCE(event.requester_credential_id,event.requester_service_id,event.principal_id),
      event.idempotency_key,event.request_hash,event.id,now()+tombstone_retention
    FROM notification_events event
    WHERE event.id=ANY(candidate_ids)
    ON CONFLICT (requester_kind,requester_id,idempotency_key) DO UPDATE SET
      request_hash=EXCLUDED.request_hash,
      original_event_id=EXCLUDED.original_event_id,
      pruned_at=now(),
      expires_at=GREATEST(notification_idempotency_tombstones.expires_at,EXCLUDED.expires_at);

    ALTER TABLE delivery_attempts DISABLE TRIGGER delivery_attempts_no_delete;
    DELETE FROM notification_events WHERE id=ANY(candidate_ids);
    GET DIAGNOSTICS pruned_count = ROW_COUNT;
    ALTER TABLE delivery_attempts ENABLE TRIGGER delivery_attempts_no_delete;
  END IF;

  DELETE FROM notification_idempotency_tombstones WHERE expires_at<=now();
  GET DIAGNOSTICS expired_count = ROW_COUNT;

  INSERT INTO notification_retention_runs(
    release_identity,cutoff_at,maximum_events_per_principal,batch_size,
    events_pruned,tombstones_expired
  ) VALUES (
    operation_release_identity,retention_cutoff,maximum_events_per_principal,
    retention_batch_size,pruned_count,expired_count
  ) RETURNING id INTO recorded_run_id;

  RETURN QUERY SELECT recorded_run_id,pruned_count,expired_count;
END;
$$;

REVOKE ALL ON notification_idempotency_tombstones,notification_retention_runs
  FROM PUBLIC,relo_runtime;
REVOKE ALL ON notification_retention_eligibility FROM PUBLIC,relo_runtime;
REVOKE ALL ON FUNCTION run_notification_retention(
  timestamptz,integer,integer,interval,text
) FROM PUBLIC,relo_runtime;
REVOKE ALL ON FUNCTION prevent_pruned_notification_replay() FROM PUBLIC,relo_runtime;

COMMENT ON FUNCTION run_notification_retention(
  timestamptz,integer,integer,interval,text
) IS 'Schema-owner-only bounded notification retention. Pending work and active activities remain protected.';
