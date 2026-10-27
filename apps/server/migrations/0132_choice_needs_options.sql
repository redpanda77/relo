-- A choice question always carries its options: the phone refuses a choice without them, and one such item in its sync
-- once took the whole inbox offline. NOT VALID checks new and changed rows only, so the migration never fails on old data.
ALTER TABLE interaction_requests ADD CONSTRAINT interaction_requests_choice_has_options
  CHECK (kind <> 'choice' OR options IS NOT NULL) NOT VALID;
