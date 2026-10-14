import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { currentTestPresentationRecord } from "./test-current-presentation.js";

describe("activity presentation lease runtime grants migration", () => {
  it("allows the non-owner API and worker to manage presentation leases without destructive privileges", async () => {
    const sql = await readFile(
      new URL("../migrations/0028_activity_presentation_lease_runtime_grants.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain(
      "GRANT SELECT,INSERT,UPDATE ON live_activity_presentation_leases TO relo_runtime",
    );
    expect(sql).toContain(
      "REVOKE DELETE,TRUNCATE ON live_activity_presentation_leases FROM relo_runtime",
    );
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

databaseSuite("activity presentation lease runtime grants", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
  });

  afterAll(async () => db.end());

  it("allows runtime projection changes while denying destructive lease deletion", async () => {
    const client = await db.connect();
    const suffix = randomUUID();
    try {
      await client.query("BEGIN");
      const principal = (await client.query<{ id: string }>(
        "INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",
        [`lease-runtime-${suffix}`],
      )).rows[0]!.id;
      const device = (await client.query<{ id: string }>(
        `INSERT INTO devices(
           principal_id,stable_device_id,installation_id,name,bundle_identifier,
           app_version,app_build,os_version,apns_environment,notification_authorization
         ) VALUES ($1,$2,$3,'Lease runtime','com.example.relo.notifications','1','1','18','sandbox','authorized')
         RETURNING id`,
        [principal, `stable-${suffix}`, `install-${suffix}`],
      )).rows[0]!.id;
      const presentation = currentTestPresentationRecord("Lease runtime","Starting");
      const activity = (await client.query<{ id: string }>(
        `INSERT INTO live_activities(
           producer_type,principal_id,activity_key,title,status,start_idempotency_key,target_device_ids,
           presentation,presentation_sha256,presentation_policy,presentation_policy_source,
           presentation_preset_id,presentation_preset_revision
         ) VALUES ('script',$1,$2,'Lease runtime','Starting',$3,ARRAY[$4]::uuid[],$5::jsonb,$6,$7::jsonb,$8,$9,$10)
         RETURNING id`,
        [principal, `lease-${suffix}`, `start-${suffix}`, device,presentation.presentation,
          presentation.presentationHash,presentation.presentationPolicy,presentation.presentationPolicySource,
          presentation.presentationPresetId,presentation.presentationPresetRevision],
      )).rows[0]!.id;

      await client.query("SET LOCAL ROLE relo_runtime");
      await client.query(
        `INSERT INTO live_activity_presentation_leases(
           live_activity_id,principal_id,device_id,scope_key,state,relevance_score,last_command_sequence
         ) VALUES ($1,$2,$3,$4,'foreground',0.72,1)`,
        [activity, principal, device, `activity:${activity}`],
      );
      await client.query(
        "UPDATE live_activity_presentation_leases SET state='background' WHERE live_activity_id=$1",
        [activity],
      );
      expect((await client.query<{ state: string }>(
        "SELECT state FROM live_activity_presentation_leases WHERE live_activity_id=$1",
        [activity],
      )).rows[0]!.state).toBe("background");
      await expect(client.query(
        "DELETE FROM live_activity_presentation_leases WHERE live_activity_id=$1",
        [activity],
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
