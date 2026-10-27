import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("migrate", () => {
  let db: Database;
  let dir: string;
  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    dir = await mkdtemp(path.join(tmpdir(), "relo-migrate-"));
    await db.query("DROP TABLE IF EXISTS migrate_probe_a, migrate_probe_b, migrate_probe_c");
  });
  afterAll(async () => {
    await db.query("DROP TABLE IF EXISTS migrate_probe_a, migrate_probe_b, migrate_probe_c");
    await db.query("DELETE FROM schema_migrations WHERE version LIKE 'zz_probe_%'");
    await db.end();
    await rm(dir, { recursive: true, force: true });
  });

  test("applies only the files not yet recorded, and a failed file is rolled back and not recorded", async () => {
    await writeFile(path.join(dir, "zz_probe_1.sql"), "CREATE TABLE migrate_probe_a (id int);");
    await migrate(db, dir);
    // A second run applies nothing (it would fail on the existing table if it tried).
    await migrate(db, dir);
    await writeFile(path.join(dir, "zz_probe_2.sql"), "CREATE TABLE migrate_probe_b (id int); SELECT 1/0;");
    await expect(migrate(db, dir)).rejects.toThrow();
    expect((await db.query("SELECT to_regclass('migrate_probe_b') AS t")).rows[0].t).toBeNull();
    await writeFile(path.join(dir, "zz_probe_2.sql"), "CREATE TABLE migrate_probe_b (id int);");
    await writeFile(path.join(dir, "zz_probe_3.sql"), "CREATE TABLE migrate_probe_c (id int);");
    await migrate(db, dir);
    const versions = (await db.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version LIKE 'zz_probe_%' ORDER BY version")).rows.map((r) => r.version);
    expect(versions).toEqual(["zz_probe_1.sql", "zz_probe_2.sql", "zz_probe_3.sql"]);
  });
});
