-- End-to-end encrypted content no reader can open any more (docs/END-TO-END-ENCRYPTION.md,
-- "Retention"): when a phone's identity key changes, or a phone or linked browser is removed, the
-- server deletes what was sealed only to the readers that are gone. An envelope stays readable
-- while any recipient is an active phone the server still lists that prekey for (it keeps more
-- prekeys than a phone keeps private ones) or an active linked browser.

CREATE FUNCTION sealed_envelope_readable(target_principal uuid,envelope jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(envelope->'recipients')='array'
      THEN envelope->'recipients' ELSE '[]'::jsonb END) recipient
    WHERE EXISTS (
        SELECT 1 FROM device_prekeys prekey JOIN devices device ON device.id=prekey.device_id
        WHERE device.principal_id=target_principal AND device.revoked_at IS NULL
          AND 'dev_'||device.id::text=recipient->>'device' AND prekey.prekey_id=recipient->>'prekey'
      )
      OR EXISTS (
        SELECT 1 FROM linked_browsers browser
        WHERE browser.principal_id=target_principal AND browser.revoked_at IS NULL AND browser.linked_at IS NOT NULL
          AND 'brw_'||browser.id::text=recipient->>'device'
      )
  )
$$;

-- Events sealed only to gone readers: their pending questions expire, then they are deleted with the
-- same idempotency tombstones retention writes (a retry of the original request stays a duplicate).
-- Events of an active card are left for the card's own end (the caller ends unreadable cards first).
CREATE FUNCTION purge_unreadable_sealed_events(target_principal uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  dead uuid[];
  purged integer := 0;
BEGIN
  SELECT array_agg(event.id) INTO dead FROM notification_events event
  WHERE event.principal_id=target_principal
    AND (jsonb_typeof(event.payload#>'{sealed,content}')='object' OR jsonb_typeof(event.payload#>'{liveActivity,sealed}')='object')
    AND NOT sealed_envelope_readable(target_principal,COALESCE(event.payload#>'{sealed,content}',event.payload#>'{liveActivity,sealed}'))
    AND NOT EXISTS (
      SELECT 1 FROM live_activities activity
      WHERE activity.principal_id=event.principal_id AND activity.state='active'
        AND event.payload#>>'{liveActivity,activityId}'='act_'||activity.id::text
    );
  IF COALESCE(cardinality(dead),0)=0 THEN RETURN 0; END IF;
  UPDATE interaction_requests SET state='expired' WHERE notification_event_id=ANY(dead) AND state='pending';
  INSERT INTO notification_idempotency_tombstones(
    principal_id,requester_kind,requester_id,idempotency_key,request_hash,original_event_id,expires_at
  )
  SELECT event.principal_id,
    CASE WHEN event.requester_credential_id IS NOT NULL THEN 'credential'
      WHEN event.requester_service_id IS NOT NULL THEN 'service' ELSE 'account' END,
    COALESCE(event.requester_credential_id,event.requester_service_id,event.principal_id),
    event.idempotency_key,event.request_hash,event.id,now()+interval '90 days'
  FROM notification_events event WHERE event.id=ANY(dead)
  ON CONFLICT (requester_kind,requester_id,idempotency_key) DO UPDATE SET
    request_hash=EXCLUDED.request_hash,original_event_id=EXCLUDED.original_event_id,pruned_at=now(),
    expires_at=GREATEST(notification_idempotency_tombstones.expires_at,EXCLUDED.expires_at);
  ALTER TABLE delivery_attempts DISABLE TRIGGER delivery_attempts_no_delete;
  DELETE FROM notification_events WHERE id=ANY(dead);
  GET DIAGNOSTICS purged = ROW_COUNT;
  ALTER TABLE delivery_attempts ENABLE TRIGGER delivery_attempts_no_delete;
  RETURN purged;
END;
$$;

REVOKE ALL ON FUNCTION sealed_envelope_readable(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_unreadable_sealed_events(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sealed_envelope_readable(uuid,jsonb) TO relo_runtime;
GRANT EXECUTE ON FUNCTION purge_unreadable_sealed_events(uuid) TO relo_runtime;
