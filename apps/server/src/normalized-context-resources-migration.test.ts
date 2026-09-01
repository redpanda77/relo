import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { hashToken } from "./auth.js";
import { createDatabase, type Database } from "./db.js";

describe("0033 normalized context resources migration",() => {
  test("freezes safe resource storage and linkage boundaries",async () => {
    const sql = await readFile(
      new URL("../migrations/0033_normalized_context_resources.sql",import.meta.url),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE resource_sources");
    expect(sql).toContain("CREATE TABLE resource_projects");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("CREATE TRIGGER notification_events_bind_context_resources");
    expect(sql).not.toContain("'activity:'||NEW.id::text");
    expect(sql).toContain("REVOKE DELETE,TRUNCATE ON resource_sources,resource_projects FROM relo_runtime");
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

databaseSuite("0033 normalized context resources PostgreSQL behavior",() => {
  let db: Database;
  beforeAll(() => { db = createDatabase(databaseUrl!); });
  afterAll(async () => db.end());

  test("backfills truthful Direct identity and enforces device-visible resource enumeration",async () => {
    const unique = randomUUID();
    const principal = (await db.query<{ id: string }>(
      "INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",
      [`resource-owner-${unique}`],
    )).rows[0]!.id;
    const ownerToken = `relo_${randomUUID().replaceAll("-","")}`;
    const credential = (await db.query<{ id: string }>(
      `INSERT INTO principal_api_keys(principal_id,label,token_hash,token_prefix,scopes)
       VALUES ($1,'Resource test CLI',$2,'test-resource',ARRAY['activities:read','notifications:send']) RETURNING id`,
      [principal,hashToken(ownerToken)],
    )).rows[0]!.id;
    const deviceRows = (await db.query<{ id: string; name: string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,
         app_version,app_build,os_version,apns_environment,notification_authorization
       ) VALUES
         ($1,$2,$3,'Visible','com.example.relo.notifications','0.8.3','10','18','sandbox','authorized'),
         ($1,$4,$5,'Hidden','com.example.relo.notifications','0.8.3','10','18','sandbox','authorized')
       RETURNING id,name`,
      [principal,`visible-${unique}`,`visible-install-${unique}`,`hidden-${unique}`,`hidden-install-${unique}`],
    )).rows;
    const visibleDevice = deviceRows.find((row) => row.name === "Visible")!.id;
    const hiddenDevice = deviceRows.find((row) => row.name === "Hidden")!.id;
    const visibleToken = `device_${randomUUID().replaceAll("-","")}`;
    const hiddenToken = `device_${randomUUID().replaceAll("-","")}`;
    await db.query(
      `INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES
       ($1,$2,ARRAY['inbox:read']),($3,$4,ARRAY['inbox:read'])`,
      [visibleDevice,hashToken(visibleToken),hiddenDevice,hashToken(hiddenToken)],
    );

    const direct = (await db.query<any>(
      `INSERT INTO notification_events(
         principal_id,requester_credential_id,source,title,body,payload,idempotency_key,target_mode
       ) VALUES ($1,$2,'Resource test CLI','Direct','Body','{"context":{"producerKind":"agent"}}',$3,'broadcast')
       RETURNING source_resource_id,project_resource_id,conversation_id,work_item_id`,
      [principal,credential,`direct-${unique}`],
    )).rows[0]!;
    expect(direct.source_resource_id).toBeTruthy();
    expect(direct.project_resource_id).toBeTruthy();
    expect(direct.conversation_id).toBeNull();
    expect(direct.work_item_id).toBeNull();

    const contextual = (await db.query<any>(
      `INSERT INTO notification_events(
         principal_id,requester_credential_id,source,title,body,payload,idempotency_key,target_mode
       ) VALUES (
         $1,$2,'Resource test CLI','Contextual','Body',
         jsonb_build_object('context',jsonb_build_object(
           'producerKind','agent','project','Visible project','providerThreadId',$3::text,
           'providerWorkItemId',$4::text,'threadName','Resource thread','taskTitle','Resource task'
         )),$5,'explicit'
       ) RETURNING id,source_resource_id,project_resource_id,conversation_id,work_item_id`,
      [principal,credential,`thread-${unique}`,`work-${unique}`,`contextual-${unique}`],
    )).rows[0]!;
    expect(contextual.conversation_id).toBeTruthy();
    expect(contextual.work_item_id).toBeTruthy();
    await db.query(
      "INSERT INTO notification_event_targets(notification_event_id,device_id) VALUES ($1,$2)",
      [contextual.id,visibleDevice],
    );

    const request = (token: string) => createApp(db).request("/api/resources/projects",{
      headers: { authorization: `Bearer ${token}` },
    });
    const ownerProjects = (await (await request(ownerToken)).json() as any).items;
    const visibleProjects = (await (await request(visibleToken)).json() as any).items;
    const hiddenProjects = (await (await request(hiddenToken)).json() as any).items;
    expect(ownerProjects.map((item: any) => item.name).sort()).toEqual(["Direct CLI","Visible project"]);
    expect(visibleProjects.map((item: any) => item.name).sort()).toEqual(["Direct CLI","Visible project"]);
    expect(hiddenProjects.map((item: any) => item.name)).toEqual(["Direct CLI"]);
    expect(JSON.stringify(ownerProjects)).not.toContain(credential);
    expect(JSON.stringify(ownerProjects)).not.toContain(`thread-${unique}`);
  });
});
