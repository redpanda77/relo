import { WORK_PLAN_MAX_NODES } from "@relo/notification-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";

// The database's plan cap must follow the contracts: a 31-step work failed in production while the
// contracts allowed 120 (16 October 2026).
const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

databaseSuite("works plan size constraint", () => {
  let db: Database;
  beforeAll(async () => { db = createDatabase(databaseUrl!); await migrate(db); });
  afterAll(async () => db.end());

  it("caps the stored plan at the contracts' node limit", async () => {
    const { rows } = await db.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'works_plan_shape'");
    expect(rows[0]?.def).toContain(`<= ${WORK_PLAN_MAX_NODES}`);
  });
});
