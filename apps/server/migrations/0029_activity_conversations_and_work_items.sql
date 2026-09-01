CREATE TABLE activity_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  correlation_key text NOT NULL,
  producer_kind text NOT NULL CHECK (producer_kind IN ('agent','service','webhook','manual')),
  provider_name text,
  provider_thread_id text,
  origin_hash text,
  computer text,
  project text,
  display_name text,
  display_name_source text CHECK (display_name_source IS NULL OR display_name_source IN ('provider','explicit','fallback')),
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id,correlation_key)
);

CREATE TABLE activity_work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES activity_conversations(id) ON DELETE CASCADE,
  correlation_key text NOT NULL,
  provider_work_item_id text,
  lifecycle_provider text,
  lifecycle_run_id text,
  title text,
  title_source text CHECK (title_source IS NULL OR title_source IN ('provider','prompt_summary','explicit','fallback')),
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id,conversation_id,correlation_key)
);

ALTER TABLE live_activities
  ADD COLUMN conversation_id uuid REFERENCES activity_conversations(id) ON DELETE SET NULL,
  ADD COLUMN work_item_id uuid REFERENCES activity_work_items(id) ON DELETE SET NULL;

CREATE INDEX activity_conversations_principal_last_seen_idx
  ON activity_conversations(principal_id,last_seen_at DESC,id DESC);
CREATE INDEX activity_work_items_conversation_last_seen_idx
  ON activity_work_items(conversation_id,last_seen_at DESC,id DESC);
CREATE INDEX live_activities_conversation_history_idx
  ON live_activities(principal_id,conversation_id,generation DESC,created_at DESC);
CREATE INDEX live_activities_work_item_history_idx
  ON live_activities(principal_id,work_item_id,created_at DESC);

CREATE FUNCTION bind_live_activity_context_resources() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  conversation_correlation text;
  work_correlation text;
  resolved_producer_kind text;
  resolved_provider_name text;
  resolved_conversation_id uuid;
  resolved_work_item_id uuid;
BEGIN
  resolved_producer_kind := CASE
    WHEN NEW.requester_service_id IS NOT NULL THEN 'service'
    ELSE CASE NEW.context->>'producerKind'
    WHEN 'agent' THEN 'agent'
    WHEN 'service' THEN 'service'
    WHEN 'webhook' THEN 'webhook'
    ELSE 'manual'
    END
  END;
  resolved_provider_name := NULLIF(NEW.context->>'providerName','');
  IF resolved_provider_name IS NULL AND NEW.requester_service_id IS NOT NULL THEN
    SELECT title INTO resolved_provider_name FROM webhook_services WHERE id=NEW.requester_service_id;
  END IF;
  conversation_correlation := COALESCE(
    NULLIF(NEW.context->>'providerThreadId',''),
    CASE WHEN NEW.origin_hash IS NOT NULL THEN 'origin:'||NEW.origin_hash END,
    'activity:'||NEW.id::text
  );
  INSERT INTO activity_conversations(
    principal_id,correlation_key,producer_kind,provider_name,provider_thread_id,
    origin_hash,computer,project,display_name,display_name_source,context_json
  ) VALUES (
    NEW.principal_id,conversation_correlation,resolved_producer_kind,
    resolved_provider_name,NULLIF(NEW.context->>'providerThreadId',''),
    NEW.origin_hash,NULLIF(NEW.context->>'computer',''),NULLIF(NEW.context->>'project',''),
    NULLIF(NEW.context->>'threadName',''),NULLIF(NEW.context->>'threadNameSource',''),
    COALESCE(NEW.context,'{}'::jsonb)
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
    last_seen_at=now()
  RETURNING id INTO resolved_conversation_id;

  work_correlation := COALESCE(
    NULLIF(NEW.context->>'providerWorkItemId',''),
    CASE WHEN NEW.lifecycle_provider IS NOT NULL AND NEW.lifecycle_run_id IS NOT NULL
      THEN NEW.lifecycle_provider||':'||NEW.lifecycle_run_id END,
    'activity:'||NEW.id::text
  );
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

  NEW.conversation_id := resolved_conversation_id;
  NEW.work_item_id := resolved_work_item_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER live_activities_bind_context_resources
BEFORE INSERT OR UPDATE OF context,origin_hash,lifecycle_provider,lifecycle_run_id,title
ON live_activities FOR EACH ROW EXECUTE FUNCTION bind_live_activity_context_resources();

UPDATE live_activities SET context=context;

GRANT SELECT,INSERT,UPDATE ON activity_conversations,activity_work_items TO relo_runtime;
REVOKE DELETE,TRUNCATE ON activity_conversations,activity_work_items FROM relo_runtime;

COMMENT ON TABLE activity_conversations IS
  'Canonical producer conversation resources: Codex tasks, service streams, webhook correlations, or manual contexts.';
COMMENT ON TABLE activity_work_items IS
  'Instruction or run resources nested under one producer conversation; Live Activity generations retain exact linkage.';
