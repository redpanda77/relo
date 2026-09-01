import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll,beforeAll,describe,expect,test } from "vitest";
import { createDatabase,type Database } from "./db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("0020 Live Activity command generations migration", () => {
  let db: Database;

  beforeAll(() => { db = createDatabase(databaseUrl!); });
  afterAll(async () => db.end());

  test("backfills durable commands and update tokens with the retained activity generation", async () => {
    const client = await db.connect();
    const schema = `activity_command_generation_${randomUUID().replaceAll("-","")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema},public`);
      await client.query(`CREATE TABLE live_activities(
        id uuid PRIMARY KEY,
        generation integer NOT NULL
      )`);
      await client.query(`CREATE TABLE notification_events(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        payload jsonb NOT NULL
      )`);
      await client.query(`CREATE TABLE live_activity_update_tokens(
        live_activity_id uuid NOT NULL,
        device_id uuid NOT NULL,
        token text NOT NULL,
        PRIMARY KEY(live_activity_id,device_id)
      )`);
      const activityId = randomUUID();
      await client.query("INSERT INTO live_activities(id,generation) VALUES ($1,3)",[activityId]);
      await client.query(
        "INSERT INTO notification_events(payload) VALUES ($1)",
        [{ liveActivity: { operation: "update",activityId: `act_${activityId}` } }],
      );
      await client.query(
        "INSERT INTO live_activity_update_tokens(live_activity_id,device_id,token) VALUES ($1,$2,'ciphertext')",
        [activityId,randomUUID()],
      );

      const migration = await readFile(
        new URL("../migrations/0020_live_activity_command_generations.sql",import.meta.url),"utf8",
      );
      await client.query(migration);

      expect((await client.query(
        "SELECT payload#>>'{liveActivity,generation}' AS generation FROM notification_events",
      )).rows).toEqual([{ generation: "3" }]);
      expect((await client.query(
        "SELECT generation FROM live_activity_update_tokens",
      )).rows).toEqual([{ generation: 3 }]);
      const constraints = await client.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid='live_activity_update_tokens'::regclass`,
      );
      expect(constraints.rows.map((row) => row.definition).join("\n")).toContain("CHECK ((generation > 0))");
      await expect(client.query(
        `INSERT INTO live_activity_update_tokens(live_activity_id,device_id,token,generation)
         VALUES ($1,$2,'invalid',0)`,
        [randomUUID(),randomUUID()],
      )).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
