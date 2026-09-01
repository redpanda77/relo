import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll,beforeAll,describe,expect,test } from "vitest";
import { createDatabase,type Database } from "./db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("0019 active origin generations migration", () => {
  let db: Database;

  beforeAll(() => { db = createDatabase(databaseUrl!); });
  afterAll(async () => db.end());

  test("backfills legacy snapshots and replaces permanent uniqueness with active uniqueness", async () => {
    const client = await db.connect();
    const schema = `origin_generation_${randomUUID().replaceAll("-","")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema},public`);
      await client.query(`CREATE TABLE live_activities(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        principal_id uuid NOT NULL,
        origin_hash text,
        state text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        start_snapshot jsonb
      )`);
      await client.query(`CREATE TABLE live_activity_operations(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        activity_snapshot jsonb
      )`);
      await client.query(`CREATE UNIQUE INDEX live_activities_origin_slot_idx
        ON live_activities(principal_id,origin_hash) WHERE origin_hash IS NOT NULL`);
      const principalId = randomUUID();
      const originHash = `org_${"a".repeat(43)}`;
      await client.query(
        `INSERT INTO live_activities(principal_id,origin_hash,state,start_snapshot)
         VALUES ($1,$2,'ended',$3)`,
        [principalId,originHash,{ id: "act_legacy",sequence: 4 }],
      );
      await client.query(
        "INSERT INTO live_activity_operations(activity_snapshot) VALUES ($1)",
        [{ id: "act_legacy",sequence: 4 }],
      );

      const migration = await readFile(
        new URL("../migrations/0019_active_origin_generations.sql",import.meta.url),"utf8",
      );
      await client.query(migration);

      expect((await client.query(
        "SELECT generation,start_snapshot FROM live_activities",
      )).rows).toEqual([{ generation: 1,start_snapshot: { id: "act_legacy",sequence: 4,generation: 1 } }]);
      expect((await client.query(
        "SELECT activity_snapshot FROM live_activity_operations",
      )).rows).toEqual([{ activity_snapshot: { id: "act_legacy",sequence: 4,generation: 1 } }]);
      await client.query(
        `INSERT INTO live_activities(principal_id,origin_hash,state,generation)
         VALUES ($1,$2,'active',2)`,
        [principalId,originHash],
      );
      await expect(client.query(
        `INSERT INTO live_activities(principal_id,origin_hash,state,generation)
         VALUES ($1,$2,'active',3)`,
        [principalId,originHash],
      )).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
