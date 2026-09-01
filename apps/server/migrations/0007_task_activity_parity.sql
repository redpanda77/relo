ALTER TYPE live_activity_state ADD VALUE IF NOT EXISTS 'expired';
ALTER TYPE live_activity_state ADD VALUE IF NOT EXISTS 'replaced';

ALTER TABLE live_activities
  ALTER COLUMN activity_key DROP NOT NULL,
  ADD COLUMN symbol text NOT NULL DEFAULT 'terminal'
    CHECK (symbol IN ('terminal','code','build','success','warning')),
  ADD COLUMN accent_color text NOT NULL DEFAULT '#5ED8B7'
    CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN stale_at timestamptz,
  ADD COLUMN start_replace_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN start_replaced_count integer NOT NULL DEFAULT 0
    CHECK (start_replaced_count >= 0);

UPDATE live_activities
SET expires_at=created_at+interval '8 hours',
    stale_at=LEAST(updated_at+interval '4 hours',created_at+interval '8 hours')
WHERE expires_at IS NULL;

UPDATE live_activities SET style='standard' WHERE style IS NULL;

ALTER TABLE live_activities
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN expires_at SET DEFAULT (now()+interval '8 hours'),
  ALTER COLUMN style SET NOT NULL,
  ALTER COLUMN style SET DEFAULT 'standard';

ALTER TABLE live_activities
  DROP CONSTRAINT IF EXISTS live_activities_principal_id_activity_key_key;

CREATE UNIQUE INDEX live_activities_principal_active_key_idx
  ON live_activities(principal_id,activity_key)
  WHERE activity_key IS NOT NULL AND state='active'
    AND style IN ('standard','ring','hero','terminal','steps');

CREATE INDEX live_activities_active_expiry_idx
  ON live_activities(expires_at)
  WHERE state='active' AND style IN ('standard','ring','hero','terminal','steps');

CREATE INDEX live_activities_target_devices_idx
  ON live_activities USING gin(target_device_ids)
  WHERE state='active' AND style IN ('standard','ring','hero','terminal','steps');

ALTER TABLE live_activities ADD CONSTRAINT live_activities_stale_before_expiry
  CHECK (stale_at IS NULL OR stale_at <= expires_at);
ALTER TABLE live_activities ADD CONSTRAINT live_activities_style_check
  CHECK (style IN ('standard','ring','hero','terminal','steps','approval','shell','verdict','signal'));

ALTER TABLE live_activity_operations
  ADD COLUMN principal_id uuid REFERENCES owner_principals(id) ON DELETE CASCADE;

UPDATE live_activity_operations o SET principal_id=a.principal_id
FROM live_activities a WHERE a.id=o.live_activity_id;

ALTER TABLE live_activity_operations ALTER COLUMN principal_id SET NOT NULL;
ALTER TABLE live_activity_operations
  DROP CONSTRAINT IF EXISTS live_activity_operations_live_activity_id_idempotency_key_key;
ALTER TABLE live_activity_operations
  ADD CONSTRAINT live_activity_operations_principal_idempotency_key_key
  UNIQUE(principal_id,idempotency_key);
