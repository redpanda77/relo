import type pg from "pg";
import { z } from "zod";
import type { Database } from "./db.js";

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const projectIdSchema = z.string().regex(new RegExp(`^prj_${uuidPattern}$`,"i"));
const conversationIdSchema = z.string().regex(new RegExp(`^cnv_${uuidPattern}$`,"i"));
const aliasIdSchema = z.string().regex(new RegExp(`^als_${uuidPattern}$`,"i"));
const displayNameSchema = z.string().trim().min(1).max(80);
const iconSchema = z.enum([
  "folder","terminal","webhook","dashboard","project","code","build","success","warning",
]);

export const projectAppearanceInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  displayName: displayNameSchema.optional(),
  icon: iconSchema.optional(),
  paletteSlot: z.number().int().min(0).max(11).optional(),
}).strict().refine((value) => value.displayName !== undefined || value.icon !== undefined || value.paletteSlot !== undefined,{
  message: "At least one project field is required.",
});

export const projectAliasInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  displayName: displayNameSchema,
}).strict();

export const projectRevisionInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
}).strict();

export const projectMergeInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  targetProjectId: projectIdSchema,
  targetExpectedRevision: z.number().int().positive(),
}).strict();

export const projectSplitInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  conversationIds: z.array(conversationIdSchema).min(1).max(100),
  destination: z.discriminatedUnion("kind",[
    z.object({ kind: z.literal("existing"), projectId: projectIdSchema, expectedRevision: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal("new"), displayName: displayNameSchema }).strict(),
  ]),
}).strict();

export class ProjectLifecycleError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type ProjectRow = {
  id: string;
  project_key: string;
  display_name: string;
  is_direct: boolean;
  revision: number;
  deleted_at: Date | string | null;
  merged_into_project_id: string | null;
};

function internalId(value: string, prefix: "prj" | "cnv" | "als"): string {
  const schema = prefix === "prj" ? projectIdSchema : prefix === "cnv" ? conversationIdSchema : aliasIdSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProjectLifecycleError(400,"invalid_resource_id","The resource identifier is invalid.");
  return parsed.data.slice(4);
}

function aliasKey(displayName: string): string {
  return `named:${displayName.trim().replace(/\s+/g," ").toLocaleLowerCase("en-US")}`;
}

async function transaction<Result>(db: Database, operation: (client: pg.PoolClient) => Promise<Result>): Promise<Result> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") {
      throw new ProjectLifecycleError(409,"project_identity_conflict","That project name or alias already belongs to another project.");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function lockProject(
  client: pg.PoolClient,
  principalId: string,
  projectPublicId: string,
  expectedRevision: number,
  options: { allowDirect?: boolean; allowDeleted?: boolean } = {},
): Promise<ProjectRow> {
  const result = await client.query<ProjectRow>(
    `SELECT id,project_key,display_name,is_direct,revision,deleted_at,merged_into_project_id
     FROM resource_projects WHERE principal_id=$1 AND id=$2 FOR UPDATE`,
    [principalId,internalId(projectPublicId,"prj")],
  );
  const project = result.rows[0];
  if (!project || project.merged_into_project_id) {
    throw new ProjectLifecycleError(404,"project_not_found","The project does not exist.");
  }
  if (!options.allowDirect && project.is_direct) {
    throw new ProjectLifecycleError(409,"direct_project_immutable","Direct projects are system identities and cannot be changed.");
  }
  if (!options.allowDeleted && project.deleted_at) {
    throw new ProjectLifecycleError(409,"project_archived","Restore the project before changing it.");
  }
  if (Number(project.revision) !== expectedRevision) {
    throw new ProjectLifecycleError(409,"stale_project_revision","The project changed. Refresh before trying again.");
  }
  return project;
}

async function nextPaletteOrdinal(client: pg.PoolClient,principalId: string,slot: number): Promise<number> {
  const result = await client.query<{ ordinal: number }>(
    `SELECT candidate AS ordinal FROM generate_series($2::int,120000,12) candidate
     WHERE NOT EXISTS (
       SELECT 1 FROM resource_projects project
       WHERE project.principal_id=$1
         AND project.palette_ordinal=candidate
     ) ORDER BY candidate LIMIT 1`,
    [principalId,slot],
  );
  const ordinal = Number(result.rows[0]?.ordinal);
  if (!Number.isSafeInteger(ordinal)) {
    throw new ProjectLifecycleError(409,"palette_exhausted","No palette identity is available for that color.");
  }
  return ordinal;
}

async function assertAliasAvailable(
  client: pg.PoolClient,
  principalId: string,
  key: string,
  projectId: string | null,
): Promise<void> {
  const conflict = await client.query(
    `SELECT 1 FROM resource_projects project
     WHERE project.principal_id=$1 AND project.project_key=$2
       AND ($3::uuid IS NULL OR project.id<>$3)
     UNION ALL
     SELECT 1 FROM resource_project_aliases alias
     WHERE alias.principal_id=$1 AND alias.alias_key=$2 AND alias.deleted_at IS NULL
       AND ($3::uuid IS NULL OR alias.project_id<>$3)
     LIMIT 1`,
    [principalId,key,projectId],
  );
  if (conflict.rowCount) {
    throw new ProjectLifecycleError(409,"project_identity_conflict","That project name or alias already belongs to another project.");
  }
}

export type ProjectMutationResult = { projectId: string; revision: number };

export async function updateProjectResource(
  db: Database,
  principalId: string,
  projectId: string,
  input: z.infer<typeof projectAppearanceInputSchema>,
): Promise<ProjectMutationResult> {
  return transaction(db,async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[principalId]);
    const project = await lockProject(client,principalId,projectId,input.expectedRevision);
    const paletteOrdinal = input.paletteSlot === undefined
      ? null
      : await nextPaletteOrdinal(client,principalId,input.paletteSlot);
    if (input.displayName !== undefined) {
      const key = aliasKey(input.displayName);
      await assertAliasAvailable(client,principalId,key,project.id);
      await client.query(
        `INSERT INTO resource_project_aliases(principal_id,project_id,alias_key,display_name,provenance)
         VALUES ($1,$2,$3,$4,'rename')
         ON CONFLICT (principal_id,alias_key) DO UPDATE SET
           project_id=EXCLUDED.project_id,display_name=EXCLUDED.display_name,
           provenance='rename',deleted_at=NULL`,
        [principalId,project.id,key,input.displayName],
      );
    }
    const result = await client.query<{ revision: number }>(
      `UPDATE resource_projects SET
         display_name=COALESCE($3,display_name),
         display_name_source=CASE WHEN $3::text IS NULL THEN display_name_source ELSE 'owner' END,
         icon=COALESCE($4,icon),
         palette_ordinal=COALESCE($5,palette_ordinal),
         appearance_updated_at=CASE WHEN $4::text IS NOT NULL OR $5::int IS NOT NULL THEN now() ELSE appearance_updated_at END,
         revision=revision+1,last_seen_at=now()
       WHERE principal_id=$1 AND id=$2 RETURNING revision`,
      [principalId,project.id,input.displayName ?? null,input.icon ?? null,paletteOrdinal],
    );
    return { projectId,revision: Number(result.rows[0]!.revision) };
  });
}

export async function addProjectAlias(
  db: Database,
  principalId: string,
  projectId: string,
  input: z.infer<typeof projectAliasInputSchema>,
): Promise<ProjectMutationResult & { aliasId: string }> {
  return transaction(db,async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[principalId]);
    const project = await lockProject(client,principalId,projectId,input.expectedRevision);
    const key = aliasKey(input.displayName);
    await assertAliasAvailable(client,principalId,key,project.id);
    const alias = await client.query<{ id: string }>(
      `INSERT INTO resource_project_aliases(principal_id,project_id,alias_key,display_name,provenance)
       VALUES ($1,$2,$3,$4,'owner')
       ON CONFLICT (principal_id,alias_key) DO UPDATE SET
         project_id=EXCLUDED.project_id,display_name=EXCLUDED.display_name,
         provenance='owner',deleted_at=NULL RETURNING id`,
      [principalId,project.id,key,input.displayName],
    );
    const updated = await client.query<{ revision: number }>(
      "UPDATE resource_projects SET revision=revision+1 WHERE id=$1 RETURNING revision",
      [project.id],
    );
    return { projectId,aliasId:`als_${alias.rows[0]!.id}`,revision:Number(updated.rows[0]!.revision) };
  });
}

export async function removeProjectAlias(
  db: Database,
  principalId: string,
  projectId: string,
  aliasId: string,
  expectedRevision: number,
): Promise<ProjectMutationResult> {
  return transaction(db,async (client) => {
    const project = await lockProject(client,principalId,projectId,expectedRevision);
    const removed = await client.query(
      `UPDATE resource_project_aliases SET deleted_at=now()
       WHERE id=$1 AND principal_id=$2 AND project_id=$3 AND deleted_at IS NULL`,
      [internalId(aliasId,"als"),principalId,project.id],
    );
    if (!removed.rowCount) throw new ProjectLifecycleError(404,"alias_not_found","The project alias does not exist.");
    const updated = await client.query<{ revision: number }>(
      "UPDATE resource_projects SET revision=revision+1 WHERE id=$1 RETURNING revision",
      [project.id],
    );
    return { projectId,revision:Number(updated.rows[0]!.revision) };
  });
}

export async function mergeProjectResource(
  db: Database,
  principalId: string,
  sourceProjectId: string,
  input: z.infer<typeof projectMergeInputSchema>,
): Promise<ProjectMutationResult> {
  if (sourceProjectId === input.targetProjectId) {
    throw new ProjectLifecycleError(400,"invalid_merge","A project cannot be merged into itself.");
  }
  return transaction(db,async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[principalId]);
    const source = await lockProject(client,principalId,sourceProjectId,input.expectedRevision);
    const target = await lockProject(client,principalId,input.targetProjectId,input.targetExpectedRevision);
    await client.query(
      `UPDATE resource_project_aliases source_alias SET deleted_at=now()
       WHERE source_alias.project_id=$1 AND source_alias.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM resource_project_aliases target_alias
           WHERE target_alias.principal_id=source_alias.principal_id
             AND target_alias.project_id=$2 AND target_alias.alias_key=source_alias.alias_key
             AND target_alias.deleted_at IS NULL
         )`,
      [source.id,target.id],
    );
    await client.query(
      "UPDATE resource_project_aliases SET project_id=$2,provenance='merge' WHERE project_id=$1 AND deleted_at IS NULL",
      [source.id,target.id],
    );
    await client.query("UPDATE notification_events SET project_resource_id=$2 WHERE principal_id=$3 AND project_resource_id=$1",[source.id,target.id,principalId]);
    await client.query("UPDATE live_activities SET project_resource_id=$2 WHERE principal_id=$3 AND project_resource_id=$1",[source.id,target.id,principalId]);
    await client.query(
      `UPDATE activity_conversations SET project_resource_id=$2,project_assignment_source='owner',last_seen_at=now()
       WHERE principal_id=$3 AND project_resource_id=$1`,
      [source.id,target.id,principalId],
    );
    await client.query("UPDATE resource_projects SET merged_into_project_id=$2 WHERE principal_id=$3 AND merged_into_project_id=$1",[source.id,target.id,principalId]);
    await client.query(
      `UPDATE resource_projects SET merged_into_project_id=$2,deleted_at=now(),tombstone_reason='merged',revision=revision+1
       WHERE id=$1`,
      [source.id,target.id],
    );
    const updated = await client.query<{ revision: number }>(
      "UPDATE resource_projects SET revision=revision+1,last_seen_at=now() WHERE id=$1 RETURNING revision",
      [target.id],
    );
    return { projectId:input.targetProjectId,revision:Number(updated.rows[0]!.revision) };
  });
}

export async function splitProjectConversations(
  db: Database,
  principalId: string,
  sourceProjectId: string,
  input: z.infer<typeof projectSplitInputSchema>,
): Promise<ProjectMutationResult & { moved: number }> {
  return transaction(db,async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[principalId]);
    const source = await lockProject(client,principalId,sourceProjectId,input.expectedRevision,{ allowDirect: true });
    let target: ProjectRow;
    let targetPublicId: string;
    if (input.destination.kind === "existing") {
      target = await lockProject(client,principalId,input.destination.projectId,input.destination.expectedRevision);
      targetPublicId = input.destination.projectId;
    } else {
      const key = aliasKey(input.destination.displayName);
      await assertAliasAvailable(client,principalId,key,null);
      const ordinal = await nextPaletteOrdinal(client,principalId,0);
      const created = await client.query<ProjectRow>(
        `INSERT INTO resource_projects(
           principal_id,project_key,display_name,display_name_source,is_direct,provenance,palette_ordinal,icon
         ) VALUES ($1,$2,$3,'owner',false,'explicit',$4,'folder')
         RETURNING id,project_key,display_name,is_direct,revision,deleted_at,merged_into_project_id`,
        [principalId,key,input.destination.displayName,ordinal],
      );
      target = created.rows[0]!;
      targetPublicId = `prj_${target.id}`;
    }
    if (source.id === target.id) throw new ProjectLifecycleError(400,"invalid_split","Choose a different destination project.");
    const conversationIds = [...new Set(input.conversationIds.map((id) => internalId(id,"cnv")))];
    const conversations = await client.query<{ id: string }>(
      `SELECT id FROM activity_conversations
       WHERE principal_id=$1 AND project_resource_id=$2 AND id=ANY($3::uuid[]) FOR UPDATE`,
      [principalId,source.id,conversationIds],
    );
    if (conversations.rowCount !== conversationIds.length) {
      throw new ProjectLifecycleError(409,"conversation_membership_changed","One or more conversations no longer belong to this project.");
    }
    await client.query(
      `UPDATE activity_conversations SET project_resource_id=$2,project_assignment_source='owner',last_seen_at=now()
       WHERE principal_id=$1 AND id=ANY($3::uuid[])`,
      [principalId,target.id,conversationIds],
    );
    await client.query("UPDATE notification_events SET project_resource_id=$2 WHERE principal_id=$1 AND conversation_id=ANY($3::uuid[])",[principalId,target.id,conversationIds]);
    await client.query("UPDATE live_activities SET project_resource_id=$2 WHERE principal_id=$1 AND conversation_id=ANY($3::uuid[])",[principalId,target.id,conversationIds]);
    await client.query("UPDATE resource_projects SET revision=revision+1 WHERE id=$1",[source.id]);
    const updated = await client.query<{ revision: number }>(
      "UPDATE resource_projects SET revision=revision+1,last_seen_at=now() WHERE id=$1 RETURNING revision",
      [target.id],
    );
    return { projectId:targetPublicId,revision:Number(updated.rows[0]!.revision),moved:conversationIds.length };
  });
}

export async function archiveProjectResource(
  db: Database,
  principalId: string,
  projectId: string,
  expectedRevision: number,
): Promise<ProjectMutationResult> {
  return transaction(db,async (client) => {
    const project = await lockProject(client,principalId,projectId,expectedRevision);
    const active = await client.query(
      `SELECT 1 FROM live_activities WHERE principal_id=$1 AND project_resource_id=$2 AND state='active' LIMIT 1`,
      [principalId,project.id],
    );
    if (active.rowCount) throw new ProjectLifecycleError(409,"project_has_active_work","End active work before archiving this project.");
    const updated = await client.query<{ revision: number }>(
      `UPDATE resource_projects SET deleted_at=now(),tombstone_reason='owner_archived',revision=revision+1
       WHERE id=$1 RETURNING revision`,
      [project.id],
    );
    return { projectId,revision:Number(updated.rows[0]!.revision) };
  });
}

export async function restoreProjectResource(
  db: Database,
  principalId: string,
  projectId: string,
  expectedRevision: number,
): Promise<ProjectMutationResult> {
  return transaction(db,async (client) => {
    const project = await lockProject(client,principalId,projectId,expectedRevision,{ allowDeleted: true });
    if (!project.deleted_at) throw new ProjectLifecycleError(409,"project_not_archived","The project is already active.");
    const updated = await client.query<{ revision: number }>(
      `UPDATE resource_projects SET deleted_at=NULL,tombstone_reason=NULL,revision=revision+1,last_seen_at=now()
       WHERE id=$1 RETURNING revision`,
      [project.id],
    );
    return { projectId,revision:Number(updated.rows[0]!.revision) };
  });
}
