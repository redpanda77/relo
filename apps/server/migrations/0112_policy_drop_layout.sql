-- Live Activity policy loses `layout` (plan 11, D5): a card shows steps when it has a plan and a progress
-- bar otherwise, so the setting never did what it said. The stored policy is { colorStrategy, accentColor }
-- and the schema is strict: a stored value that still has `layout` would fail to parse and silently become
-- "no policy", so every stored policy is rewritten here.
UPDATE principal_api_keys SET live_activity_policy = live_activity_policy - 'layout'
WHERE live_activity_policy IS NOT NULL AND live_activity_policy ? 'layout';

UPDATE webhook_services SET live_activity_policy = live_activity_policy - 'layout'
WHERE live_activity_policy IS NOT NULL AND live_activity_policy ? 'layout';

UPDATE owner_principals SET live_activity_policy = live_activity_policy - 'layout'
WHERE live_activity_policy IS NOT NULL AND live_activity_policy ? 'layout';
