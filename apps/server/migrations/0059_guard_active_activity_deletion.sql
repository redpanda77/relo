-- An active card lives on the owner's phone. Deleting its row without an end push leaves a card
-- the server can no longer update or end (6 October: a history wipe left orphaned cards on the
-- phone). End cards first (`end-active-activities`); account deletion opts in explicitly because
-- it revokes the phone's credential, which ends every card on the device.
CREATE FUNCTION refuse_active_activity_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'active' AND coalesce(current_setting('relo.allow_active_activity_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'live activity % is active; end it with an end push before deleting it', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER live_activities_refuse_active_deletion
  BEFORE DELETE ON live_activities
  FOR EACH ROW EXECUTE FUNCTION refuse_active_activity_deletion();
