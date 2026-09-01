ALTER TABLE live_activities
  ADD COLUMN terminal_reason text,
  ADD COLUMN terminal_actor text,
  ADD COLUMN terminal_policy text,
  ADD COLUMN terminal_transition_at timestamptz,
  ADD COLUMN presentation_preset_id text,
  ADD COLUMN presentation_preset_revision integer;

ALTER TABLE live_activities
  ADD CONSTRAINT live_activities_preset_revision_positive
    CHECK (presentation_preset_revision IS NULL OR presentation_preset_revision>0),
  ADD CONSTRAINT live_activities_terminal_provenance_complete
    CHECK (
      (terminal_transition_at IS NULL AND terminal_reason IS NULL AND terminal_actor IS NULL)
      OR (terminal_transition_at IS NOT NULL AND terminal_reason IS NOT NULL AND terminal_actor IS NOT NULL)
    );

CREATE TABLE live_activity_presentation_leases (
  live_activity_id uuid NOT NULL REFERENCES live_activities(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN (
    'eligible','foreground','background','pending_token','not_presented','ending','ended','unknown'
  )),
  reason text,
  relevance_score double precision NOT NULL DEFAULT 0
    CHECK (relevance_score>=0 AND relevance_score<=1),
  last_command_sequence bigint NOT NULL DEFAULT 0 CHECK (last_command_sequence>=0),
  selected_at timestamptz,
  last_applied_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(live_activity_id,device_id)
);

CREATE UNIQUE INDEX live_activity_presentation_leases_foreground_device_idx
  ON live_activity_presentation_leases(principal_id,device_id)
  WHERE state='foreground';

CREATE INDEX live_activity_presentation_leases_activity_idx
  ON live_activity_presentation_leases(live_activity_id,updated_at DESC);

CREATE INDEX live_activity_presentation_leases_device_state_idx
  ON live_activity_presentation_leases(principal_id,device_id,state,updated_at DESC);

WITH expanded AS (
  SELECT a.id AS live_activity_id,a.principal_id,target.device_id,a.sequence,a.updated_at,
    row_number() OVER (
      PARTITION BY a.principal_id,target.device_id
      ORDER BY a.updated_at DESC,a.created_at DESC,a.id DESC
    ) AS device_rank
  FROM live_activities a
  CROSS JOIN LATERAL unnest(COALESCE(a.target_device_ids,'{}'::uuid[])) target(device_id)
  WHERE a.state='active'
    AND (a.presentation IS NOT NULL OR a.style IN ('standard','ring','hero','terminal','steps'))
)
INSERT INTO live_activity_presentation_leases(
  live_activity_id,principal_id,device_id,state,reason,relevance_score,
  last_command_sequence,selected_at,created_at,updated_at
)
SELECT live_activity_id,principal_id,device_id,
  CASE WHEN device_rank=1 THEN 'foreground' ELSE 'background' END,
  CASE WHEN device_rank=1 THEN 'initial_selection' ELSE 'device_slot_policy' END,
  0.6,sequence,
  CASE WHEN device_rank=1 THEN now() ELSE NULL END,
  now(),now()
FROM expanded
ON CONFLICT DO NOTHING;
