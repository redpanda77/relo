import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDatabase, type Database } from "./db.js";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  import.meta.url.endsWith(".ts") ? "../migrations" : "../migrations",
);

export async function migrate(db: Database, directory = migrationsDirectory): Promise<void> {
  const lock = await db.connect();
  await lock.query("SELECT pg_advisory_lock(hashtext('relo-schema-migrations'))");
  try {
    await lock.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const exists = await lock.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
      if (exists.rowCount) continue;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(await readFile(path.join(directory, file), "utf8"));
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('relo-schema-migrations'))");
    lock.release();
  }
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL is required for schema-owner migrations");
  const db = createDatabase(databaseUrl);
  try {
    await migrate(db);
  } finally {
    await db.end();
  }
}
