import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll,beforeAll,describe,expect,test } from "vitest";
import { createDatabase,type Database } from "./db.js";
import {
  ProjectLifecycleError,
  addProjectAlias,
  archiveProjectResource,
  mergeProjectResource,
  projectAppearanceInputSchema,
  projectSplitInputSchema,
  restoreProjectResource,
  splitProjectConversations,
  updateProjectResource,
} from "./project-resource-lifecycle.js";

describe("0034 context resource lifecycle contract",() => {
  test("pins owner precedence, persistent splits, redirects, and schema-owner GC",async () => {
    const sql = await readFile(new URL("../migrations/0034_context_resource_lifecycle.sql",import.meta.url),"utf8");
    expect(sql).toContain("display_name_source text NOT NULL");
    expect(sql).toContain("CREATE TABLE resource_project_aliases");
    expect(sql).toContain("project_assignment_source text NOT NULL");
    expect(sql).toContain("activity_conversations.project_assignment_source='owner'");
    expect(sql).toContain("merged_into_project_id");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("REVOKE ALL ON FUNCTION run_context_resource_gc");
    expect(sql).not.toContain("payload->>'body'");
  });

  test("rejects unbounded and ambiguous project mutations",() => {
    expect(projectAppearanceInputSchema.safeParse({ expectedRevision:1 }).success).toBe(false);
    expect(projectAppearanceInputSchema.safeParse({ expectedRevision:1,paletteSlot:12 }).success).toBe(false);
    expect(projectSplitInputSchema.safeParse({
      expectedRevision:1,
      conversationIds:[],
      destination:{ kind:"new",displayName:"Split" },
    }).success).toBe(false);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

databaseSuite("0034 context resource lifecycle PostgreSQL behavior",() => {
  let db: Database;
  beforeAll(() => { db=createDatabase(databaseUrl!); });
  afterAll(async () => db.end());

  test("fences revisions and preserves owner lifecycle decisions",async () => {
    const suffix = randomUUID();
    const principalId = (await db.query<{ id:string }>(
      "INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",
      [`lifecycle-${suffix}`],
    )).rows[0]!.id;
    const sourceId = (await db.query<{ id:string }>(
      `INSERT INTO resource_sources(principal_id,source_key,kind,display_name,provenance)
       VALUES ($1,$2,'cli','Lifecycle CLI','credential') RETURNING id`,
      [principalId,`test:${suffix}`],
    )).rows[0]!.id;
    const rows = (await db.query<{ id:string;revision:number }>(
      `INSERT INTO resource_projects(
         principal_id,project_key,display_name,display_name_source,is_direct,provenance,palette_ordinal,icon,direct_source_id
       ) VALUES
         ($1,$2,'Alpha','producer',false,'explicit',0,'folder',NULL),
         ($1,$3,'Direct CLI','derived',true,'derived',1,'terminal',$4)
       RETURNING id,revision`,
      [principalId,`named:alpha-${suffix}`,`direct:${sourceId}`,sourceId],
    )).rows;
    const alphaId = `prj_${rows[0]!.id}`;
    const directId = `prj_${rows[1]!.id}`;

    const renamed = await updateProjectResource(db,principalId,alphaId,{
      expectedRevision:1,displayName:"Owner Alpha",paletteSlot:3,icon:"code",
    });
    expect(renamed.revision).toBe(2);
    await expect(updateProjectResource(db,principalId,alphaId,{
      expectedRevision:1,displayName:"Stale",
    })).rejects.toMatchObject({ code:"stale_project_revision" });
    await expect(updateProjectResource(db,principalId,directId,{
      expectedRevision:1,displayName:"Not allowed",
    })).rejects.toBeInstanceOf(ProjectLifecycleError);

    const aliased = await addProjectAlias(db,principalId,alphaId,{
      expectedRevision:2,displayName:"Alpha Alias",
    });
    expect(aliased.revision).toBe(3);
    const conversationId = (await db.query<{ id:string }>(
      `INSERT INTO activity_conversations(
         principal_id,correlation_key,producer_kind,context_json,source_resource_id,project_resource_id
       ) VALUES ($1,$2,'agent','{}',$3,$4) RETURNING id`,
      [principalId,`conversation:${suffix}`,sourceId,rows[0]!.id],
    )).rows[0]!.id;
    const split = await splitProjectConversations(db,principalId,alphaId,{
      expectedRevision:3,
      conversationIds:[`cnv_${conversationId}`],
      destination:{ kind:"new",displayName:"Beta" },
    });
    expect(split.moved).toBe(1);
    expect((await db.query<{ project_assignment_source:string }>(
      "SELECT project_assignment_source FROM activity_conversations WHERE id=$1",
      [conversationId],
    )).rows[0]!.project_assignment_source).toBe("owner");

    const sourceRevision = (await db.query<{ revision:number }>("SELECT revision FROM resource_projects WHERE id=$1",[rows[0]!.id])).rows[0]!.revision;
    const merged = await mergeProjectResource(db,principalId,split.projectId,{
      expectedRevision:split.revision,
      targetProjectId:alphaId,
      targetExpectedRevision:Number(sourceRevision),
    });
    const archived = await archiveProjectResource(db,principalId,alphaId,merged.revision);
    const restored = await restoreProjectResource(db,principalId,alphaId,archived.revision);
    expect(restored.revision).toBe(archived.revision+1);

    await db.query("DELETE FROM owner_principals WHERE id=$1",[principalId]);
  });
});
