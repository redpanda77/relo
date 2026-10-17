import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

// Every table the API or worker touches must be granted to relo_runtime; a missing grant only shows in
// production ("permission denied for table work_handoffs", 16 October 2026). A table kept from the
// runtime on purpose is listed here with its reason.
const OWNER_ONLY = new Set<string>([
  "public.context_resource_gc_runs", // revoked in 0034: written only by the retention function
  "public.notification_idempotency_tombstones", // revoked in 0025: retention function only
  "public.notification_retention_runs", // revoked in 0025: retention function only
]);

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

databaseSuite("runtime table grants", () => {
  let db: Database;
  beforeAll(async () => { db = createDatabase(databaseUrl!); await migrate(db); });
  afterAll(async () => db.end());

  it("grants every application table to relo_runtime", async () => {
    const { rows } = await db.query<{ name: string }>(`
      SELECT n.nspname || '.' || c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
        AND NOT has_table_privilege('relo_runtime', c.oid, 'SELECT')
      ORDER BY 1`);
    expect(rows.map((row) => row.name).filter((name) => !OWNER_ONLY.has(name))).toEqual([]);
  });
});
