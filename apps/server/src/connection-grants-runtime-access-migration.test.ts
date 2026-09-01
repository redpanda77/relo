import { readFile } from "node:fs/promises";
import { afterAll,beforeAll,describe,expect,test } from "vitest";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";

describe("connection grant runtime access migration",() => {
  test("grants only the access required by pairing",async () => {
    const sql = await readFile(
      new URL("../migrations/0040_connection_grants_runtime_access.sql",import.meta.url),
      "utf8",
    );
    expect(sql).toContain("GRANT SELECT,INSERT,UPDATE ON connection_grants TO relo_runtime");
    expect(sql).toContain("REVOKE DELETE,TRUNCATE ON connection_grants FROM relo_runtime");
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

databaseSuite("connection grant runtime access",() => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
  });

  afterAll(async () => db.end());

  test("allows pairing reads and mutations while denying destructive access",async () => {
    const result = await db.query<{
      can_select: boolean;can_insert: boolean;can_update: boolean;
      can_delete: boolean;can_truncate: boolean;
    }>(
      `SELECT
         has_table_privilege('relo_runtime','connection_grants','SELECT') AS can_select,
         has_table_privilege('relo_runtime','connection_grants','INSERT') AS can_insert,
         has_table_privilege('relo_runtime','connection_grants','UPDATE') AS can_update,
         has_table_privilege('relo_runtime','connection_grants','DELETE') AS can_delete,
         has_table_privilege('relo_runtime','connection_grants','TRUNCATE') AS can_truncate`,
    );
    expect(result.rows[0]).toEqual({
      can_select: true,can_insert: true,can_update: true,
      can_delete: false,can_truncate: false,
    });
  });
});
