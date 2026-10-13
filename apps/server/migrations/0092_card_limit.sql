-- The owner may cap how many cards one CLI login keeps open (an app that should not crowd the Lock
-- Screen). NULL: no cap, which agents with several sessions on one login need.
ALTER TABLE principal_api_keys ADD COLUMN max_active_cards smallint
  CHECK (max_active_cards IS NULL OR max_active_cards BETWEEN 1 AND 10);
