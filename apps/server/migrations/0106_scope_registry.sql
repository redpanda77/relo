-- The scope registry (packages/contracts/src/scopes.ts) is the one list of scopes. Column defaults follow it, and
-- devices:pair, which no route ever required, is gone from defaults and stored credentials.
-- scope-registry.test.ts compares these defaults with the registry.
UPDATE principal_api_keys SET scopes=array_remove(scopes,'devices:pair') WHERE 'devices:pair'=ANY(scopes);
UPDATE device_credentials SET scopes=array_remove(scopes,'devices:pair') WHERE 'devices:pair'=ANY(scopes);
UPDATE device_authorizations SET requested_scopes=array_remove(requested_scopes,'devices:pair')
  WHERE 'devices:pair'=ANY(requested_scopes);
ALTER TABLE principal_api_keys
  ALTER COLUMN scopes SET DEFAULT ARRAY[
    'notifications:send','interactions:create','interactions:read',
    'activities:write','activities:read','devices:read',
    'services:read','services:write'
  ]::text[];
ALTER TABLE device_credentials
  ALTER COLUMN scopes SET DEFAULT ARRAY['device:self','inbox:read','interactions:respond']::text[];
