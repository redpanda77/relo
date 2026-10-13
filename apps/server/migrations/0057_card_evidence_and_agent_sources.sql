-- Proof that a card appeared on a phone. ActivityKit hands the phone a push token only once it
-- has created the card, and the token row is deleted when the card ends; this row is kept.
CREATE TABLE live_activity_phone_evidence (
  live_activity_id uuid NOT NULL REFERENCES live_activities(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  shown_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (live_activity_id,device_id)
);
GRANT SELECT,INSERT ON live_activity_phone_evidence TO relo_runtime;

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
    -- One source per agent: Claude Code and Codex sharing a login stay separate sources.
    resolved_source_key := 'credential:'||resolved_credential_id::text
      ||COALESCE(':'||lower(NULLIF(BTRIM(supplied_context->>'providerName'),'')),'');
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
