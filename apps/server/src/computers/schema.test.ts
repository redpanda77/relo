import { COMPUTER_ICONS, COMPUTER_NAME_MAX } from "@relo/notification-contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";

/** ADR 0011: the table's CHECKs equal the contracts' enum and length. */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("computers schema", () => {
  let db: Database;
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => { await db.end(); });

  test("the icon and name checks equal the contracts", async () => {
    const checks = await db.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='computers'::regclass AND contype='c'`,
    );
    const text = checks.rows.map((row) => row.definition).join("\n");
    const icons = [...text.matchAll(/'([a-z]+)'::text/gu)].map((match) => match[1]).sort();
    expect(icons).toEqual([...COMPUTER_ICONS].sort());
    expect(text).toContain(`<= ${COMPUTER_NAME_MAX}`);
  });

  test("the runtime role can use the table and hooks credentials link to it", async () => {
    const grants = await db.query(`SELECT 1 FROM information_schema.role_table_grants WHERE table_name='computers' AND grantee='relo_runtime' AND privilege_type='INSERT'`);
    expect(grants.rowCount).toBe(1);
    const column = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name='harness_credentials' AND column_name='computer_id'`);
    expect(column.rowCount).toBe(1);
  });
});
