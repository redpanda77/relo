ALTER TABLE delivery_jobs
  ADD COLUMN provider_retry_attempt_cap integer,
  ADD COLUMN provider_retry_horizon_at timestamptz,
  ADD COLUMN provider_next_attempt_not_before timestamptz;

-- P0-03 did not persist the exact retry timestamp. Active legacy provider
-- histories therefore cannot be replayed safely after this upgrade.
UPDATE delivery_jobs
SET state='reconciliation_required',claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,
    lease_expires_at=NULL,last_error_code='legacy_provider_retry_schedule_unknown',
    last_error_message='Provider retry history predates durable next-attempt scheduling',
    updated_at=now()
WHERE state IN ('pending','retry','processing') AND provider_attempts_used>0;

ALTER TABLE delivery_jobs
  ADD CONSTRAINT delivery_jobs_provider_retry_schedule_check CHECK (
    (provider_retry_attempt_cap IS NULL
      AND provider_retry_horizon_at IS NULL
      AND provider_next_attempt_not_before IS NULL)
    OR
    (provider_attempts_used>0
      AND provider_retry_started_at IS NOT NULL
      AND provider_retry_attempt_cap>0
      AND provider_retry_horizon_at>provider_retry_started_at
      AND provider_next_attempt_not_before>=provider_retry_started_at)
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='relo_runtime') THEN
    CREATE ROLE relo_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

ALTER ROLE relo_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

DO $$
DECLARE inherited_role name;
BEGIN
  FOR inherited_role IN
    SELECT granted.rolname
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid=membership.member
    JOIN pg_roles granted ON granted.oid=membership.roleid
    WHERE member.rolname='relo_runtime'
  LOOP
    EXECUTE format('REVOKE %I FROM relo_runtime',inherited_role);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relowner='relo_runtime'::regrole)
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner='relo_runtime'::regrole)
    OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner='relo_runtime'::regrole)
    OR EXISTS (
      SELECT 1 FROM pg_database
      WHERE datname=current_database() AND datdba='relo_runtime'::regrole
    ) THEN
    RAISE EXCEPTION 'relo_runtime unexpectedly owns database objects';
  END IF;
END;
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO relo_runtime',current_database());
END;
$$;

GRANT USAGE ON SCHEMA public,auth TO relo_runtime;
REVOKE CREATE ON SCHEMA public,auth FROM relo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON
  owner_principals,principal_api_keys,devices,device_credentials,pairing_codes,
  notification_events,delivery_jobs,interaction_requests,interactions,
  live_activities,live_activity_operations,account_identities,
  device_registration_idempotency,device_authorizations,webhook_services,
  notification_event_targets,live_activity_update_tokens,request_rate_limits
TO relo_runtime;
GRANT SELECT,INSERT ON delivery_attempts TO relo_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON
  auth.users,auth.sessions,auth.accounts,auth.verifications
TO relo_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public,auth TO relo_runtime;
REVOKE UPDATE,DELETE ON delivery_attempts FROM relo_runtime;

COMMENT ON ROLE relo_runtime IS
  'Non-owner API/worker role. Login/password are provisioned outside migrations; schema ownership and controlled retention are forbidden.';
