ALTER TABLE owner_principals
  ADD COLUMN live_activity_policy jsonb;

ALTER TABLE principal_api_keys
  ADD COLUMN live_activity_policy jsonb;

ALTER TABLE webhook_services
  ADD COLUMN live_activity_policy jsonb;

ALTER TABLE live_activities
  ADD COLUMN presentation_policy jsonb,
  ADD COLUMN presentation_policy_source text;

ALTER TABLE live_activities
  ADD CONSTRAINT live_activities_presentation_policy_source_check
  CHECK (presentation_policy_source IS NULL OR presentation_policy_source IN (
    'invocation','client','service','account','system'
  ));
