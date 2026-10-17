/**
 * Vitest global setup: the DB suites skip without TEST_DATABASE_URL, and a skip must never read as a pass
 * (plan 10 C4). This says so once per run; `scripts/gates.sh --db` runs them and fails a file that ran nothing.
 * With a database it prepares the per-worker template (worker-database.ts): migrated once, leftovers dropped.
 */
import { createDatabase } from "../db.js";
import { migrate } from "../migrate.js";
import { dropWorkerDatabases, perWorkerEligible } from "./worker-database.js";

export default async function databaseNotice(): Promise<void> {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    console.warn("\n[relo] TEST_DATABASE_URL is not set: every database suite is SKIPPED, not passed. "
      + "Run them with scripts/gates.sh --db (a throwaway Postgres) or set TEST_DATABASE_URL.\n");
    return;
  }
  const url = new URL(value);
  if (!perWorkerEligible(url)) return;
  await dropWorkerDatabases(url);
  const template = createDatabase(value);
  try { await migrate(template); } finally { await template.end(); }
}
