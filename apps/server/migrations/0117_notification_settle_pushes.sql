-- A notification that stops being active (a question answered on any surface, settled as another copy of
-- its decision, expired, canceled, superseded; any notice withdrawn) leaves the phones that were shown it.
-- Each phone sent the alert gets one silent background push naming the notification's public id
-- ({"relo":{"settled":["ntf_..."]}}); notifications/settle-pushes.ts sends them.
--
-- One choke point: every writer moves notification_events.state out of 'active', so the trigger below
-- queues the settle pushes wherever the transition happens. Only devices whose alert job for that event
-- reached APNs (or may have: in flight, or awaiting reconciliation) are queued; one row per (event, device)
-- keeps repeated transitions from queueing twice.
CREATE TABLE notification_settle_pushes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_event_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','skipped','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_token uuid,
  lease_expires_at timestamptz,
  outcome_category text,
  provider_status integer CHECK (provider_status IS NULL OR provider_status BETWEEN 100 AND 599),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (notification_event_id,device_id),
  CONSTRAINT notification_settle_pushes_claim_check CHECK (
    (state='processing') = (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX notification_settle_pushes_due_idx
  ON notification_settle_pushes(available_at,id) WHERE state='pending';
CREATE INDEX notification_settle_pushes_lease_idx
  ON notification_settle_pushes(lease_expires_at) WHERE state='processing';
CREATE INDEX notification_settle_pushes_device_idx ON notification_settle_pushes(device_id);

CREATE FUNCTION queue_notification_settle_pushes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notification_settle_pushes(notification_event_id,device_id)
  SELECT DISTINCT j.notification_event_id,j.device_id FROM delivery_jobs j
  WHERE j.notification_event_id=NEW.id AND j.transport='notification'
    AND (j.state IN ('accepted','reconciliation_required')
      OR (j.state='processing' AND j.claim_phase='dispatch_started'))
  ON CONFLICT (notification_event_id,device_id) DO NOTHING;
  IF FOUND THEN PERFORM pg_notify('relo_settle_pushes','ready'); END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER notification_events_queue_settle_pushes
AFTER UPDATE OF state ON notification_events
FOR EACH ROW WHEN (OLD.state='active' AND NEW.state<>'active')
EXECUTE FUNCTION queue_notification_settle_pushes();

GRANT SELECT,INSERT,UPDATE,DELETE ON notification_settle_pushes TO relo_runtime;
