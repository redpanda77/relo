-- Hints become visible only on commit. They contain identities, never content,
-- credentials, response text or delivery capabilities. Authoritative reads and
-- periodic reconciliation recover any missed hint; no replay log is needed.
CREATE FUNCTION notify_current_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed record;
  principal uuid;
  subject text;
BEGIN
  IF TG_OP='DELETE' THEN changed := OLD; ELSE changed := NEW; END IF;
  IF TG_TABLE_NAME NOT IN ('notification_event_targets','notification_relevance','device_credentials','owner_principals') THEN
    principal := changed.principal_id;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'notification_events' THEN subject := 'ntf_'||changed.id::text;
    WHEN 'interaction_requests' THEN subject := 'ntf_'||changed.notification_event_id::text;
    WHEN 'notification_event_targets' THEN
      SELECT e.principal_id INTO principal FROM notification_events e WHERE e.id=changed.notification_event_id;
      subject := 'ntf_'||changed.notification_event_id::text;
    WHEN 'relevance_subjects' THEN subject := 'sub_'||changed.id::text;
    WHEN 'notification_relevance' THEN
      SELECT s.principal_id INTO principal FROM relevance_subjects s WHERE s.id=changed.subject_id;
      subject := 'sub_'||changed.subject_id::text;
    WHEN 'live_activities' THEN subject := 'act_'||changed.id::text;
    WHEN 'device_credentials' THEN
      SELECT d.principal_id INTO principal FROM devices d WHERE d.id=changed.device_id;
    WHEN 'owner_principals' THEN principal := changed.id;
    ELSE NULL; -- Resource changes and authorization changes reconcile the scope.
  END CASE;
  -- After deletion there may no longer be a visible row to authorize its ID.
  IF TG_OP='DELETE' THEN subject := NULL; END IF;
  IF principal IS NOT NULL THEN
    PERFORM pg_notify('relo_current_changes',json_build_object('principalId',principal,'subjectId',subject)::text);
  END IF;
  IF TG_TABLE_NAME='devices' AND TG_OP='UPDATE' THEN
    IF OLD.principal_id IS DISTINCT FROM NEW.principal_id THEN
      PERFORM pg_notify('relo_current_changes',json_build_object('principalId',OLD.principal_id,'subjectId',NULL)::text);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER current_event_insert_delete AFTER INSERT OR DELETE ON notification_events
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_event_update AFTER UPDATE OF updated_at,read_at,state,withdrawn_at,expires_at ON notification_events
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_target_change AFTER INSERT OR DELETE ON notification_event_targets
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_interaction_insert_delete AFTER INSERT OR DELETE ON interaction_requests
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_interaction_update AFTER UPDATE OF state,expires_at ON interaction_requests
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_subject_change AFTER INSERT OR UPDATE OR DELETE ON relevance_subjects
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_relevance_change AFTER INSERT OR UPDATE OR DELETE ON notification_relevance
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_activity_change AFTER INSERT OR UPDATE OR DELETE ON live_activities
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_project_change AFTER UPDATE ON resource_projects
FOR EACH ROW WHEN ((OLD.display_name,OLD.is_direct,OLD.palette_ordinal,OLD.icon,OLD.revision,OLD.deleted_at,OLD.merged_into_project_id)
 IS DISTINCT FROM (NEW.display_name,NEW.is_direct,NEW.palette_ordinal,NEW.icon,NEW.revision,NEW.deleted_at,NEW.merged_into_project_id))
EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_project_delete AFTER DELETE ON resource_projects
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_source_change AFTER UPDATE ON resource_sources
FOR EACH ROW WHEN ((OLD.display_name,OLD.kind,OLD.deleted_at) IS DISTINCT FROM (NEW.display_name,NEW.kind,NEW.deleted_at))
EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_source_delete AFTER DELETE ON resource_sources
FOR EACH ROW EXECUTE FUNCTION notify_current_change();

-- Exclude last_used_at and last_seen_at: authentication must not notify itself.
CREATE TRIGGER current_principal_revocation AFTER UPDATE OF disabled_at ON owner_principals
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_principal_delete AFTER DELETE ON owner_principals
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_key_revocation AFTER UPDATE OF revoked_at,expires_at,scopes ON principal_api_keys
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_key_delete AFTER DELETE ON principal_api_keys
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_device_revocation AFTER UPDATE OF revoked_at,credential_version,principal_id ON devices
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_device_delete AFTER DELETE ON devices
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_device_key_revocation AFTER UPDATE OF revoked_at,expires_at,scopes ON device_credentials
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
CREATE TRIGGER current_device_key_delete AFTER DELETE ON device_credentials
FOR EACH ROW EXECUTE FUNCTION notify_current_change();
