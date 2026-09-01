ALTER TABLE notification_events
  ADD COLUMN requester_credential_id uuid REFERENCES principal_api_keys(id) ON DELETE CASCADE,
  ADD COLUMN requester_service_id uuid REFERENCES webhook_services(id) ON DELETE CASCADE,
  ADD CONSTRAINT notification_events_requester_family_check
    CHECK (num_nonnulls(requester_credential_id,requester_service_id) <= 1);

UPDATE notification_events
SET requester_service_id=service_id
WHERE service_id IS NOT NULL;

ALTER TABLE notification_events
  DROP CONSTRAINT IF EXISTS notification_events_principal_id_idempotency_key_key;

CREATE UNIQUE INDEX notification_events_principal_idempotency_idx
  ON notification_events(principal_id,idempotency_key)
  WHERE requester_credential_id IS NULL AND requester_service_id IS NULL;

CREATE UNIQUE INDEX notification_events_credential_idempotency_idx
  ON notification_events(requester_credential_id,idempotency_key)
  WHERE requester_credential_id IS NOT NULL;

CREATE UNIQUE INDEX notification_events_service_idempotency_idx
  ON notification_events(requester_service_id,idempotency_key)
  WHERE requester_service_id IS NOT NULL;

CREATE INDEX notification_events_credential_created_idx
  ON notification_events(requester_credential_id,created_at DESC)
  WHERE requester_credential_id IS NOT NULL;

CREATE INDEX notification_events_service_created_idx
  ON notification_events(requester_service_id,created_at DESC)
  WHERE requester_service_id IS NOT NULL;
