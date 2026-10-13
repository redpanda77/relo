CREATE FUNCTION notify_interaction_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    PERFORM pg_notify('relo_interaction_changes',json_build_object(
      'principalId',NEW.principal_id,'interactionId',NEW.id)::text);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER interaction_requests_notify_change
AFTER UPDATE OF state,expires_at ON interaction_requests
FOR EACH ROW EXECUTE FUNCTION notify_interaction_change();
