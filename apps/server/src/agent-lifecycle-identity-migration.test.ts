import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll,beforeAll,describe,expect,test } from "vitest";
import { createDatabase,type Database } from "./db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("0022 agent lifecycle identity migration", () => {
  let db: Database;

  beforeAll(() => { db = createDatabase(databaseUrl!); });
  afterAll(async () => db.end());

  test("binds one opaque provider run per credential or service requester", async () => {
    const client = await db.connect();
    const schema = `agent_lifecycle_${randomUUID().replaceAll("-","")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema},public`);
      await client.query(`CREATE TABLE live_activities(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        principal_id uuid NOT NULL,
        requester_credential_id uuid,
        requester_service_id uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      const migration = await readFile(
        new URL("../migrations/0022_agent_lifecycle_identity.sql",import.meta.url),"utf8",
      );
      await client.query(migration);
      const principalId = randomUUID();
      const credentialId = randomUUID();
      await client.query(
        `INSERT INTO live_activities(principal_id,requester_credential_id,lifecycle_provider,lifecycle_run_id)
         VALUES ($1,$2,'codex','codex-run-123')`,
        [principalId,credentialId],
      );
      await client.query("SAVEPOINT duplicate_lifecycle_identity");
      await expect(client.query(
        `INSERT INTO live_activities(principal_id,requester_credential_id,lifecycle_provider,lifecycle_run_id)
         VALUES ($1,$2,'codex','codex-run-123')`,
        [principalId,credentialId],
      )).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_lifecycle_identity");
      await client.query("SAVEPOINT incomplete_lifecycle_identity");
      await expect(client.query(
        `INSERT INTO live_activities(principal_id,requester_credential_id,lifecycle_provider)
         VALUES ($1,$2,'codex')`,
        [principalId,credentialId],
      )).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK TO SAVEPOINT incomplete_lifecycle_identity");
      const serviceId = randomUUID();
      await client.query(
        `INSERT INTO live_activities(principal_id,requester_service_id,lifecycle_provider,lifecycle_run_id)
         VALUES ($1,$2,'acp','acp-run-123')`,
        [principalId,serviceId],
      );
      await client.query("SAVEPOINT duplicate_service_lifecycle_identity");
      await expect(client.query(
        `INSERT INTO live_activities(principal_id,requester_service_id,lifecycle_provider,lifecycle_run_id)
         VALUES ($1,$2,'acp','acp-run-123')`,
        [principalId,serviceId],
      )).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_service_lifecycle_identity");
      await expect(client.query(
        `INSERT INTO live_activities(principal_id,requester_service_id,lifecycle_provider,lifecycle_run_id)
         VALUES ($1,$2,'acp','acp-run-123')`,
        [principalId,randomUUID()],
      )).resolves.toMatchObject({ rowCount: 1 });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
