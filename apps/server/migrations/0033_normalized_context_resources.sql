CREATE TABLE resource_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('agent','cli','service','webhook','dashboard','manual')),
  display_name text NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('credential','service','explicit','derived')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (principal_id,source_key)
);

CREATE TABLE resource_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  project_key text NOT NULL,
  display_name text NOT NULL,
  is_direct boolean NOT NULL DEFAULT false,
  provenance text NOT NULL CHECK (provenance IN ('explicit','derived')),
  palette_ordinal integer NOT NULL CHECK (palette_ordinal >= 0),
  icon text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  direct_source_id uuid REFERENCES resource_sources(id) ON DELETE RESTRICT,
  merged_into_project_id uuid REFERENCES resource_projects(id) ON DELETE RESTRICT,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (principal_id,project_key),
  UNIQUE (principal_id,palette_ordinal),
  CHECK ((is_direct AND direct_source_id IS NOT NULL) OR (NOT is_direct AND direct_source_id IS NULL)),
  CHECK (merged_into_project_id IS NULL OR merged_into_project_id <> id)
);

ALTER TABLE notification_events
  ADD COLUMN source_resource_id uuid REFERENCES resource_sources(id) ON DELETE RESTRICT,
  ADD COLUMN project_resource_id uuid REFERENCES resource_projects(id) ON DELETE RESTRICT,
  ADD COLUMN conversation_id uuid REFERENCES activity_conversations(id) ON DELETE SET NULL,
  ADD COLUMN work_item_id uuid REFERENCES activity_work_items(id) ON DELETE SET NULL;

ALTER TABLE live_activities
  ADD COLUMN source_resource_id uuid REFERENCES resource_sources(id) ON DELETE RESTRICT,
  ADD COLUMN project_resource_id uuid REFERENCES resource_projects(id) ON DELETE RESTRICT;

ALTER TABLE activity_conversations
  ADD COLUMN source_resource_id uuid REFERENCES resource_sources(id) ON DELETE RESTRICT,
  ADD COLUMN project_resource_id uuid REFERENCES resource_projects(id) ON DELETE RESTRICT;

CREATE INDEX resource_sources_principal_page_idx
  ON resource_sources(principal_id,first_seen_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX resource_projects_principal_page_idx
  ON resource_projects(principal_id,first_seen_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX notification_events_resource_project_idx
  ON notification_events(principal_id,project_resource_id,created_at DESC,id DESC);
CREATE INDEX notification_events_resource_source_idx
  ON notification_events(principal_id,source_resource_id,created_at DESC,id DESC);
CREATE INDEX live_activities_resource_project_idx
  ON live_activities(principal_id,project_resource_id,created_at DESC,id DESC);
CREATE INDEX activity_conversations_resource_page_idx
  ON activity_conversations(principal_id,first_seen_at DESC,id DESC);

CREATE FUNCTION bind_context_source_project(
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
  SELECT id INTO resolved_project_id FROM resource_projects
    WHERE principal_id=resolved_principal_id AND project_key=resolved_project_key;
  IF resolved_project_id IS NULL THEN
    SELECT COALESCE(MAX(palette_ordinal)+1,0) INTO next_palette_ordinal
      FROM resource_projects WHERE principal_id=resolved_principal_id;
    INSERT INTO resource_projects(
      principal_id,project_key,display_name,is_direct,provenance,palette_ordinal,icon,direct_source_id
    ) VALUES (
      resolved_principal_id,resolved_project_key,resolved_project_name,resolved_project_direct,
      CASE WHEN resolved_project_direct THEN 'derived' ELSE 'explicit' END,
      next_palette_ordinal,resolved_project_icon,
      CASE WHEN resolved_project_direct THEN resolved_source_id ELSE NULL END
    ) RETURNING id INTO resolved_project_id;
  ELSE
    UPDATE resource_projects SET
      display_name=resolved_project_name,
      icon=resolved_project_icon,
      last_seen_at=now(),
      deleted_at=NULL
    WHERE id=resolved_project_id;
  END IF;
END;
$$;

CREATE FUNCTION bind_notification_context_resources() RETURNS trigger
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
    project_resource_id=EXCLUDED.project_resource_id,
    last_seen_at=now()
  RETURNING id INTO resolved_conversation_id;
  NEW.conversation_id := resolved_conversation_id;

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
    project_resource_id=EXCLUDED.project_resource_id,
    last_seen_at=now()
  RETURNING id INTO resolved_conversation_id;
  NEW.conversation_id := resolved_conversation_id;

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

CREATE TRIGGER notification_events_bind_context_resources
BEFORE INSERT OR UPDATE OF payload,origin_hash,source,requester_credential_id,requester_service_id,title
ON notification_events FOR EACH ROW EXECUTE FUNCTION bind_notification_context_resources();

UPDATE notification_events SET payload=payload;
UPDATE live_activities SET context=context;

GRANT SELECT,INSERT,UPDATE ON resource_sources,resource_projects TO relo_runtime;
REVOKE DELETE,TRUNCATE ON resource_sources,resource_projects FROM relo_runtime;

COMMENT ON TABLE resource_sources IS
  'Account-scoped producer identities. Internal source keys are never exposed through the resource API.';
COMMENT ON TABLE resource_projects IS
  'Stable account-scoped named and source-specific direct project identities with persisted palette allocation.';
COMMENT ON COLUMN resource_projects.palette_ordinal IS
  'Stable collision allocation. Clients derive slot modulo 12 and generation by integer division.';
