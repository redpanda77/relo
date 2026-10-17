import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FACTS } from "@relo/notification-contracts";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

/** Plan 10 M6: a fact that the schema also states (a column default) must agree with the facts module. */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("facts the schema also states", () => {
  let db: Database;
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => { await db.end(); });

  test("a server's question limit starts at the facts' server cap", async () => {
    const column = await db.query<{ column_default: string }>(
      "SELECT column_default FROM information_schema.columns WHERE table_name='server_settings' AND column_name='max_question_seconds'");
    expect(Number(column.rows[0]!.column_default)).toBe(FACTS.question.serverCapSeconds);
  });
});
