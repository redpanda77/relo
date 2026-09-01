ALTER TABLE resource_projects
  ADD COLUMN display_name_source text NOT NULL DEFAULT 'producer'
    CHECK (display_name_source IN ('producer','owner','derived')),
  ADD COLUMN tombstone_reason text,
  ADD COLUMN appearance_updated_at timestamptz;

UPDATE resource_projects
SET display_name_source=CASE WHEN is_direct THEN 'derived' ELSE 'producer' END;

CREATE TABLE resource_project_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES resource_projects(id) ON DELETE CASCADE,
  alias_key text NOT NULL,
  display_name text NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('owner','rename','merge')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (principal_id,alias_key)
);

CREATE INDEX resource_project_aliases_project_idx
  ON resource_project_aliases(principal_id,project_id,created_at,id)
  WHERE deleted_at IS NULL;

ALTER TABLE activity_conversations
  ADD COLUMN project_assignment_source text NOT NULL DEFAULT 'producer'
    CHECK (project_assignment_source IN ('producer','owner'));

CREATE TABLE context_resource_gc_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_identity text NOT NULL,
  retention_cutoff timestamptz NOT NULL,
  batch_size integer NOT NULL,
  aliases_pruned integer NOT NULL,
  projects_pruned integer NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION reject_context_resource_gc_run_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'context_resource_gc_runs rows are append-only';
END;
$$;

CREATE TRIGGER context_resource_gc_runs_no_update
BEFORE UPDATE ON context_resource_gc_runs
FOR EACH ROW EXECUTE FUNCTION reject_context_resource_gc_run_mutation();

CREATE TRIGGER context_resource_gc_runs_no_delete
BEFORE DELETE ON context_resource_gc_runs
FOR EACH ROW EXECUTE FUNCTION reject_context_resource_gc_run_mutation();

CREATE OR REPLACE FUNCTION bind_context_source_project(
  resolved_principal_id uuid,
  resolved_credential_id uuid,
  resolved_service_id uuid,
  supplied_source_name text,
  supplied_context jsonb,
  OUT resolved_source_id uuid,
  OUT resolved_project_id uuid
) RETURNS record
LANGUAGE plpgsql AS $$
DECLARE
  resolved_source_key text;
  resolved_source_kind text;
  resolved_source_name text;
  resolved_source_provenance text;
  resolved_project_name text;
  resolved_project_key text;
  resolved_project_direct boolean;
  resolved_project_icon text;
  next_palette_ordinal integer;
BEGIN
  IF resolved_service_id IS NOT NULL THEN
    resolved_source_key := 'service:'||resolved_service_id::text;
    resolved_source_kind := CASE WHEN supplied_context->>'producerKind'='service' THEN 'service' ELSE 'webhook' END;
    SELECT COALESCE(NULLIF(BTRIM(supplied_source_name),''),NULLIF(BTRIM(title),''),'Webhook')
      INTO resolved_source_name FROM webhook_services WHERE id=resolved_service_id;
    resolved_source_provenance := 'service';
  ELSIF resolved_credential_id IS NOT NULL THEN
    resolved_source_key := 'credential:'||resolved_credential_id::text;
    resolved_source_kind := CASE WHEN supplied_context->>'producerKind'='agent' THEN 'agent' ELSE 'cli' END;
    SELECT COALESCE(NULLIF(BTRIM(supplied_source_name),''),NULLIF(BTRIM(label),''),'CLI')
      INTO resolved_source_name FROM principal_api_keys WHERE id=resolved_credential_id;
    resolved_source_provenance := 'credential';
  ELSE
    resolved_source_name := COALESCE(NULLIF(BTRIM(supplied_source_name),''),'RELO');
    resolved_source_key := 'derived:'||lower(regexp_replace(resolved_source_name,'\\s+',' ','g'));
    resolved_source_kind := CASE WHEN lower(resolved_source_name)='relo' THEN 'dashboard' ELSE 'manual' END;
    resolved_source_provenance := 'derived';
  END IF;

  INSERT INTO resource_sources(principal_id,source_key,kind,display_name,provenance)
  VALUES (resolved_principal_id,resolved_source_key,resolved_source_kind,resolved_source_name,resolved_source_provenance)
  ON CONFLICT (principal_id,source_key) DO UPDATE SET
    kind=EXCLUDED.kind,
    display_name=EXCLUDED.display_name,
    provenance=EXCLUDED.provenance,
    last_seen_at=now(),
    deleted_at=NULL
  RETURNING id INTO resolved_source_id;

  resolved_project_name := NULLIF(BTRIM(supplied_context->>'project'),'');
  resolved_project_direct := resolved_project_name IS NULL;
  IF resolved_project_direct THEN
    resolved_project_key := 'direct:'||resolved_source_id::text;
    resolved_project_name := CASE resolved_source_kind
      WHEN 'agent' THEN 'Direct CLI'
      WHEN 'cli' THEN 'Direct CLI'
      WHEN 'service' THEN 'Direct webhook'
      WHEN 'webhook' THEN 'Direct webhook'
      WHEN 'dashboard' THEN 'Dashboard'
      ELSE 'Direct calls'
    END;
    resolved_project_icon := CASE resolved_source_kind
      WHEN 'agent' THEN 'terminal'
      WHEN 'cli' THEN 'terminal'
      WHEN 'service' THEN 'webhook'
      WHEN 'webhook' THEN 'webhook'
      WHEN 'dashboard' THEN 'dashboard'
      ELSE 'project'
    END;
  ELSE
    resolved_project_key := 'named:'||lower(regexp_replace(resolved_project_name,'\\s+',' ','g'));
    resolved_project_icon := 'folder';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(resolved_principal_id::text));
  SELECT COALESCE(project.merged_into_project_id,project.id) INTO resolved_project_id
  FROM resource_projects project
  WHERE project.principal_id=resolved_principal_id AND project.project_key=resolved_project_key;

  IF resolved_project_id IS NULL AND NOT resolved_project_direct THEN
    SELECT COALESCE(project.merged_into_project_id,project.id) INTO resolved_project_id
    FROM resource_project_aliases alias
    JOIN resource_projects project ON project.id=alias.project_id AND project.principal_id=alias.principal_id
    WHERE alias.principal_id=resolved_principal_id
      AND alias.alias_key=resolved_project_key
      AND alias.deleted_at IS NULL;
  END IF;

  IF resolved_project_id IS NULL THEN
    SELECT candidate INTO next_palette_ordinal
    FROM generate_series(0,(
      SELECT COALESCE(MAX(palette_ordinal),-1)+1
      FROM resource_projects WHERE principal_id=resolved_principal_id
    )) candidate
    WHERE NOT EXISTS (
      SELECT 1 FROM resource_projects project
      WHERE project.principal_id=resolved_principal_id
        AND project.palette_ordinal=candidate
    )
    ORDER BY candidate LIMIT 1;
    INSERT INTO resource_projects(
      principal_id,project_key,display_name,display_name_source,is_direct,provenance,
      palette_ordinal,icon,direct_source_id
    ) VALUES (
      resolved_principal_id,resolved_project_key,resolved_project_name,
      CASE WHEN resolved_project_direct THEN 'derived' ELSE 'producer' END,
      resolved_project_direct,CASE WHEN resolved_project_direct THEN 'derived' ELSE 'explicit' END,
      next_palette_ordinal,resolved_project_icon,
      CASE WHEN resolved_project_direct THEN resolved_source_id ELSE NULL END
    ) RETURNING id INTO resolved_project_id;
  ELSE
    UPDATE resource_projects SET
      display_name=CASE
        WHEN display_name_source='owner' THEN display_name
        ELSE resolved_project_name
      END,
      display_name_source=CASE
        WHEN display_name_source='owner' THEN display_name_source
        WHEN resolved_project_direct THEN 'derived'
        ELSE 'producer'
      END,
      icon=CASE WHEN appearance_updated_at IS NULL THEN resolved_project_icon ELSE icon END,
      last_seen_at=now(),
      deleted_at=NULL,
      tombstone_reason=NULL
    WHERE id=resolved_project_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION bind_notification_context_resources() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  supplied_context jsonb := COALESCE(NEW.payload->'context','{}'::jsonb);
  resolved_source_id uuid;
  resolved_project_id uuid;
  conversation_correlation text;
  resolved_conversation_id uuid;
  resolved_work_item_id uuid;
  resolved_producer_kind text;
BEGIN
  SELECT binding.resolved_source_id,binding.resolved_project_id
    INTO resolved_source_id,resolved_project_id
    FROM bind_context_source_project(
      NEW.principal_id,NEW.requester_credential_id,NEW.requester_service_id,NEW.source,supplied_context
    ) binding;
  NEW.source_resource_id := resolved_source_id;
  NEW.project_resource_id := resolved_project_id;

  conversation_correlation := COALESCE(
    NULLIF(supplied_context->>'providerThreadId',''),
    CASE WHEN NEW.origin_hash IS NOT NULL THEN 'origin:'||NEW.origin_hash END
  );
  NEW.conversation_id := NULL;
  NEW.work_item_id := NULL;
  IF conversation_correlation IS NULL THEN RETURN NEW; END IF;

  resolved_producer_kind := CASE
    WHEN NEW.requester_service_id IS NOT NULL THEN 'service'
    WHEN supplied_context->>'producerKind' IN ('agent','service','webhook') THEN supplied_context->>'producerKind'
    ELSE 'manual'
  END;
  INSERT INTO activity_conversations(
    principal_id,correlation_key,producer_kind,provider_name,provider_thread_id,
    origin_hash,computer,project,display_name,display_name_source,context_json,
    source_resource_id,project_resource_id
  ) VALUES (
    NEW.principal_id,conversation_correlation,resolved_producer_kind,
    NULLIF(supplied_context->>'providerName',''),NULLIF(supplied_context->>'providerThreadId',''),
    NEW.origin_hash,NULLIF(supplied_context->>'computer',''),NULLIF(supplied_context->>'project',''),
    NULLIF(supplied_context->>'threadName',''),NULLIF(supplied_context->>'threadNameSource',''),
    supplied_context,resolved_source_id,resolved_project_id
  )
  ON CONFLICT (principal_id,correlation_key) DO UPDATE SET
    provider_name=COALESCE(EXCLUDED.provider_name,activity_conversations.provider_name),
    provider_thread_id=COALESCE(EXCLUDED.provider_thread_id,activity_conversations.provider_thread_id),
    origin_hash=COALESCE(EXCLUDED.origin_hash,activity_conversations.origin_hash),
    computer=COALESCE(EXCLUDED.computer,activity_conversations.computer),
    project=COALESCE(EXCLUDED.project,activity_conversations.project),
    display_name=COALESCE(EXCLUDED.display_name,activity_conversations.display_name),
    display_name_source=COALESCE(EXCLUDED.display_name_source,activity_conversations.display_name_source),
    context_json=activity_conversations.context_json||EXCLUDED.context_json,
    source_resource_id=EXCLUDED.source_resource_id,
    project_resource_id=CASE
      WHEN activity_conversations.project_assignment_source='owner'
        THEN activity_conversations.project_resource_id
      ELSE EXCLUDED.project_resource_id
    END,
    last_seen_at=now()
  RETURNING id,project_resource_id INTO resolved_conversation_id,resolved_project_id;
  NEW.conversation_id := resolved_conversation_id;
  NEW.project_resource_id := resolved_project_id;

  IF NULLIF(supplied_context->>'providerWorkItemId','') IS NOT NULL THEN
    INSERT INTO activity_work_items(
      principal_id,conversation_id,correlation_key,provider_work_item_id,title,title_source,context_json
    ) VALUES (
      NEW.principal_id,resolved_conversation_id,supplied_context->>'providerWorkItemId',
      supplied_context->>'providerWorkItemId',COALESCE(NULLIF(supplied_context->>'taskTitle',''),NEW.title),
      COALESCE(NULLIF(supplied_context->>'taskTitleSource',''),'fallback'),supplied_context
    )
    ON CONFLICT (principal_id,conversation_id,correlation_key) DO UPDATE SET
      title=COALESCE(NULLIF(EXCLUDED.title,''),activity_work_items.title),
      title_source=COALESCE(EXCLUDED.title_source,activity_work_items.title_source),
      context_json=activity_work_items.context_json||EXCLUDED.context_json,
      last_seen_at=now()
    RETURNING id INTO resolved_work_item_id;
    NEW.work_item_id := resolved_work_item_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION bind_live_activity_context_resources() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conversation_correlation text;
  work_correlation text;
  resolved_producer_kind text;
  resolved_provider_name text;
  resolved_conversation_id uuid;
  resolved_work_item_id uuid;
  resolved_source_id uuid;
  resolved_project_id uuid;
BEGIN
  resolved_producer_kind := CASE
    WHEN NEW.requester_service_id IS NOT NULL THEN 'service'
    WHEN NEW.context->>'producerKind' IN ('agent','service','webhook') THEN NEW.context->>'producerKind'
    ELSE 'manual'
  END;
  resolved_provider_name := NULLIF(NEW.context->>'providerName','');
  IF resolved_provider_name IS NULL AND NEW.requester_service_id IS NOT NULL THEN
    SELECT title INTO resolved_provider_name FROM webhook_services WHERE id=NEW.requester_service_id;
  END IF;

  SELECT binding.resolved_source_id,binding.resolved_project_id
    INTO resolved_source_id,resolved_project_id
    FROM bind_context_source_project(
      NEW.principal_id,NEW.requester_credential_id,NEW.requester_service_id,
      COALESCE(resolved_provider_name,'RELO'),COALESCE(NEW.context,'{}'::jsonb)
    ) binding;
  NEW.source_resource_id := resolved_source_id;
  NEW.project_resource_id := resolved_project_id;
  NEW.conversation_id := NULL;
  NEW.work_item_id := NULL;

  conversation_correlation := COALESCE(
    NULLIF(NEW.context->>'providerThreadId',''),
    CASE WHEN NEW.origin_hash IS NOT NULL THEN 'origin:'||NEW.origin_hash END
  );
  IF conversation_correlation IS NULL THEN RETURN NEW; END IF;

  INSERT INTO activity_conversations(
    principal_id,correlation_key,producer_kind,provider_name,provider_thread_id,
    origin_hash,computer,project,display_name,display_name_source,context_json,
    source_resource_id,project_resource_id
  ) VALUES (
    NEW.principal_id,conversation_correlation,resolved_producer_kind,
    resolved_provider_name,NULLIF(NEW.context->>'providerThreadId',''),
    NEW.origin_hash,NULLIF(NEW.context->>'computer',''),NULLIF(NEW.context->>'project',''),
    NULLIF(NEW.context->>'threadName',''),NULLIF(NEW.context->>'threadNameSource',''),
    COALESCE(NEW.context,'{}'::jsonb),resolved_source_id,resolved_project_id
  )
  ON CONFLICT (principal_id,correlation_key) DO UPDATE SET
    producer_kind=EXCLUDED.producer_kind,
    provider_name=COALESCE(EXCLUDED.provider_name,activity_conversations.provider_name),
    provider_thread_id=COALESCE(EXCLUDED.provider_thread_id,activity_conversations.provider_thread_id),
    origin_hash=COALESCE(EXCLUDED.origin_hash,activity_conversations.origin_hash),
    computer=COALESCE(EXCLUDED.computer,activity_conversations.computer),
    project=COALESCE(EXCLUDED.project,activity_conversations.project),
    display_name=COALESCE(EXCLUDED.display_name,activity_conversations.display_name),
    display_name_source=COALESCE(EXCLUDED.display_name_source,activity_conversations.display_name_source),
    context_json=activity_conversations.context_json||EXCLUDED.context_json,
    source_resource_id=EXCLUDED.source_resource_id,
    project_resource_id=CASE
      WHEN activity_conversations.project_assignment_source='owner'
        THEN activity_conversations.project_resource_id
      ELSE EXCLUDED.project_resource_id
    END,
    last_seen_at=now()
  RETURNING id,project_resource_id INTO resolved_conversation_id,resolved_project_id;
  NEW.conversation_id := resolved_conversation_id;
  NEW.project_resource_id := resolved_project_id;

  work_correlation := COALESCE(
    NULLIF(NEW.context->>'providerWorkItemId',''),
    CASE WHEN NEW.lifecycle_provider IS NOT NULL AND NEW.lifecycle_run_id IS NOT NULL
      THEN NEW.lifecycle_provider||':'||NEW.lifecycle_run_id END
  );
  IF work_correlation IS NULL THEN RETURN NEW; END IF;

  INSERT INTO activity_work_items(
    principal_id,conversation_id,correlation_key,provider_work_item_id,
    lifecycle_provider,lifecycle_run_id,title,title_source,context_json
  ) VALUES (
    NEW.principal_id,resolved_conversation_id,work_correlation,
    NULLIF(NEW.context->>'providerWorkItemId',''),NEW.lifecycle_provider,NEW.lifecycle_run_id,
    COALESCE(NULLIF(NEW.context->>'taskTitle',''),NEW.title),
    COALESCE(NULLIF(NEW.context->>'taskTitleSource',''),'fallback'),
    COALESCE(NEW.context,'{}'::jsonb)
  )
  ON CONFLICT (principal_id,conversation_id,correlation_key) DO UPDATE SET
    provider_work_item_id=COALESCE(EXCLUDED.provider_work_item_id,activity_work_items.provider_work_item_id),
    lifecycle_provider=COALESCE(EXCLUDED.lifecycle_provider,activity_work_items.lifecycle_provider),
    lifecycle_run_id=COALESCE(EXCLUDED.lifecycle_run_id,activity_work_items.lifecycle_run_id),
    title=COALESCE(NULLIF(EXCLUDED.title,''),activity_work_items.title),
    title_source=COALESCE(EXCLUDED.title_source,activity_work_items.title_source),
    context_json=activity_work_items.context_json||EXCLUDED.context_json,
    last_seen_at=now()
  RETURNING id INTO resolved_work_item_id;
  NEW.work_item_id := resolved_work_item_id;
  RETURN NEW;
END;
$$;

CREATE FUNCTION run_context_resource_gc(
  retention_cutoff timestamptz,
  resource_batch_size integer,
  operation_release_identity text
) RETURNS TABLE(run_id uuid,aliases_pruned integer,projects_pruned integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  candidate_ids uuid[];
  alias_count integer := 0;
  project_count integer := 0;
  recorded_run_id uuid;
BEGIN
  IF retention_cutoff IS NULL OR retention_cutoff>now()
    OR resource_batch_size<1 OR resource_batch_size>5000
    OR operation_release_identity !~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$' THEN
    RAISE EXCEPTION 'invalid context resource retention parameters';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('relo:context-resource-gc:v1'));
  SELECT array_agg(candidate.id ORDER BY candidate.deleted_at,candidate.id)
  INTO candidate_ids
  FROM (
    SELECT project.id,project.deleted_at
    FROM resource_projects project
    WHERE project.deleted_at<retention_cutoff
      AND project.is_direct=false
      AND project.merged_into_project_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM notification_events event WHERE event.project_resource_id=project.id)
      AND NOT EXISTS (SELECT 1 FROM live_activities activity WHERE activity.project_resource_id=project.id)
      AND NOT EXISTS (SELECT 1 FROM activity_conversations conversation WHERE conversation.project_resource_id=project.id)
      AND NOT EXISTS (SELECT 1 FROM resource_project_aliases alias WHERE alias.project_id=project.id AND alias.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM resource_projects merged WHERE merged.merged_into_project_id=project.id)
      AND NOT EXISTS (SELECT 1 FROM resource_projects direct WHERE direct.direct_source_id IS NOT NULL AND direct.id=project.id)
    ORDER BY project.deleted_at,project.id
    LIMIT resource_batch_size
    FOR UPDATE SKIP LOCKED
  ) candidate;

  IF COALESCE(cardinality(candidate_ids),0)>0 THEN
    DELETE FROM resource_project_aliases WHERE project_id=ANY(candidate_ids);
    GET DIAGNOSTICS alias_count = ROW_COUNT;
    DELETE FROM resource_projects WHERE id=ANY(candidate_ids);
    GET DIAGNOSTICS project_count = ROW_COUNT;
  END IF;

  INSERT INTO context_resource_gc_runs(
    release_identity,retention_cutoff,batch_size,aliases_pruned,projects_pruned
  ) VALUES (
    operation_release_identity,retention_cutoff,resource_batch_size,alias_count,project_count
  ) RETURNING id INTO recorded_run_id;

  RETURN QUERY SELECT recorded_run_id,alias_count,project_count;
END;
$$;

GRANT SELECT,INSERT,UPDATE ON resource_project_aliases TO relo_runtime;
REVOKE DELETE,TRUNCATE ON resource_project_aliases FROM relo_runtime;
REVOKE ALL ON context_resource_gc_runs FROM PUBLIC,relo_runtime;
REVOKE ALL ON FUNCTION run_context_resource_gc(timestamptz,integer,text)
  FROM PUBLIC,relo_runtime;

COMMENT ON TABLE resource_project_aliases IS
  'Account-scoped owner aliases. Alias keys and redirect provenance are not exposed to device clients.';
COMMENT ON COLUMN resource_projects.display_name_source IS
  'Owner display precedence prevents producer refresh from overwriting an explicit rename.';
COMMENT ON COLUMN resource_projects.palette_ordinal IS
  'Stable server-owned palette identity; owner color changes allocate the first unused generation in a selected slot.';
COMMENT ON COLUMN activity_conversations.project_assignment_source IS
  'Owner assignment preserves an explicit split against later producer refreshes.';
COMMENT ON FUNCTION run_context_resource_gc(timestamptz,integer,text) IS
  'Schema-owner-only bounded collection of aged, completely unreferenced Project tombstones.';
