-- Live Activity policy v2 (plan 11, phase 2): { layout, colorStrategy, accentColor }.
-- layout: 'steps' stays 'steps'; every other old preset (automatic, standard, terminal) is 'progress'.
-- colorStrategy: 'fixed' stays; 'thread' and 'project' are 'project'.
-- theme and symbol are dropped. A stored value that does not parse is treated as "no policy", so every
-- stored policy must be rewritten here. Rows already in the new shape (they have 'layout') are left alone.
UPDATE principal_api_keys SET live_activity_policy = jsonb_build_object(
  'layout', CASE live_activity_policy->>'preset' WHEN 'steps' THEN 'steps' ELSE 'progress' END,
  'colorStrategy', CASE live_activity_policy->>'colorStrategy' WHEN 'fixed' THEN 'fixed' ELSE 'project' END,
  'accentColor', COALESCE(live_activity_policy->>'accentColor', '#5ED8B7'))
WHERE live_activity_policy IS NOT NULL AND NOT (live_activity_policy ? 'layout');

UPDATE webhook_services SET live_activity_policy = jsonb_build_object(
  'layout', CASE live_activity_policy->>'preset' WHEN 'steps' THEN 'steps' ELSE 'progress' END,
  'colorStrategy', CASE live_activity_policy->>'colorStrategy' WHEN 'fixed' THEN 'fixed' ELSE 'project' END,
  'accentColor', COALESCE(live_activity_policy->>'accentColor', '#5ED8B7'))
WHERE live_activity_policy IS NOT NULL AND NOT (live_activity_policy ? 'layout');

UPDATE owner_principals SET live_activity_policy = jsonb_build_object(
  'layout', CASE live_activity_policy->>'preset' WHEN 'steps' THEN 'steps' ELSE 'progress' END,
  'colorStrategy', CASE live_activity_policy->>'colorStrategy' WHEN 'fixed' THEN 'fixed' ELSE 'project' END,
  'accentColor', COALESCE(live_activity_policy->>'accentColor', '#5ED8B7'))
WHERE live_activity_policy IS NOT NULL AND NOT (live_activity_policy ? 'layout');
