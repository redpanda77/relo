ALTER TABLE principal_api_keys
  ALTER COLUMN scopes SET DEFAULT ARRAY[
    'notifications:send','interactions:create','interactions:read',
    'activities:write','activities:read','devices:pair','devices:read',
    'services:read','services:write'
  ]::text[];

UPDATE principal_api_keys
SET scopes = array_append(scopes,'services:read')
WHERE scopes @> ARRAY['services:write']::text[]
  AND NOT scopes @> ARRAY['services:read']::text[];
