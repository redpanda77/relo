ALTER TABLE live_activities
  ADD COLUMN presentation jsonb,
  ADD COLUMN presentation_sha256 text CHECK (
    presentation_sha256 IS NULL OR presentation_sha256 ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT live_activities_presentation_v2_check CHECK (
    presentation IS NULL OR (
      jsonb_typeof(presentation)='object'
      AND presentation->>'version'='2'
      AND octet_length(presentation::text)<=4096
    )
  ),
  ADD CONSTRAINT live_activities_presentation_hash_pair_check CHECK (
    (presentation IS NULL)=(presentation_sha256 IS NULL)
  );

ALTER TABLE live_activity_operations
  ADD COLUMN presentation_snapshot jsonb,
  ADD COLUMN presentation_snapshot_sha256 text CHECK (
    presentation_snapshot_sha256 IS NULL OR presentation_snapshot_sha256 ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT live_activity_operations_presentation_v2_check CHECK (
    presentation_snapshot IS NULL OR (
      jsonb_typeof(presentation_snapshot)='object'
      AND presentation_snapshot->>'version'='2'
      AND octet_length(presentation_snapshot::text)<=4096
    )
  ),
  ADD CONSTRAINT live_activity_operations_presentation_hash_pair_check CHECK (
    (presentation_snapshot IS NULL)=(presentation_snapshot_sha256 IS NULL)
  );

CREATE FUNCTION capture_live_activity_presentation_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.activity_snapshot IS NOT NULL
     AND jsonb_typeof(NEW.activity_snapshot)='object'
     AND NEW.activity_snapshot ? 'presentation' THEN
    NEW.presentation_snapshot := NEW.activity_snapshot->'presentation';
    NEW.presentation_snapshot_sha256 := NEW.activity_snapshot->>'presentationHash';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER live_activity_operations_capture_presentation
BEFORE INSERT OR UPDATE OF activity_snapshot ON live_activity_operations
FOR EACH ROW EXECUTE FUNCTION capture_live_activity_presentation_snapshot();

UPDATE live_activity_operations
SET presentation_snapshot=activity_snapshot->'presentation',
    presentation_snapshot_sha256=activity_snapshot->>'presentationHash'
WHERE presentation_snapshot IS NULL
  AND jsonb_typeof(activity_snapshot)='object'
  AND activity_snapshot ? 'presentation'
  AND activity_snapshot ? 'presentationHash';

CREATE TABLE presentation_assets (
  asset_id text PRIMARY KEY CHECK (asset_id ~ '^ast_[A-Za-z0-9_-]{12,}$'),
  principal_id uuid NOT NULL REFERENCES owner_principals(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/webp')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5000000),
  pixel_width integer NOT NULL CHECK (pixel_width BETWEEN 1 AND 4096),
  pixel_height integer NOT NULL CHECK (pixel_height BETWEEN 1 AND 4096),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL DEFAULT (now()+interval '30 days'),
  deleted_at timestamptz,
  CONSTRAINT presentation_assets_content_size_check CHECK (octet_length(content)=byte_size)
);

CREATE INDEX presentation_assets_principal_created_idx
  ON presentation_assets(principal_id,created_at DESC,asset_id);
CREATE UNIQUE INDEX presentation_assets_principal_digest_active_idx
  ON presentation_assets(principal_id,sha256)
  WHERE deleted_at IS NULL;
CREATE INDEX presentation_assets_retention_idx
  ON presentation_assets(retain_until)
  WHERE deleted_at IS NOT NULL;

CREATE FUNCTION reject_presentation_asset_identity_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.asset_id IS DISTINCT FROM OLD.asset_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.media_type IS DISTINCT FROM OLD.media_type
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
    OR NEW.pixel_width IS DISTINCT FROM OLD.pixel_width
    OR NEW.pixel_height IS DISTINCT FROM OLD.pixel_height
    OR NEW.content IS DISTINCT FROM OLD.content
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.retain_until IS DISTINCT FROM OLD.retain_until THEN
    RAISE EXCEPTION 'presentation asset identity and content are immutable';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'deleted presentation assets cannot be restored or changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER presentation_assets_immutable
BEFORE UPDATE ON presentation_assets
FOR EACH ROW EXECUTE FUNCTION reject_presentation_asset_identity_mutation();

REVOKE ALL ON presentation_assets FROM PUBLIC;
GRANT SELECT,INSERT ON presentation_assets TO relo_runtime;
GRANT UPDATE (deleted_at) ON presentation_assets TO relo_runtime;
REVOKE DELETE,TRUNCATE ON presentation_assets FROM relo_runtime;

COMMENT ON COLUMN live_activities.presentation IS
  'Canonical private-projected Presentation V2 JSON. NULL identifies a legacy row pending application normalization.';
COMMENT ON COLUMN live_activity_operations.presentation_snapshot IS
  'Canonical Presentation V2 value captured with the immutable operation snapshot.';
COMMENT ON TABLE presentation_assets IS
  'Account-scoped immutable image cache. Origin URLs and request credentials are never persisted.';
