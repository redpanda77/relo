/**
 * One database per Vitest worker, so DB suites run in parallel without sharing tables (they TRUNCATE freely).
 *
 * TEST_DATABASE_URL names the base database. The global setup migrates it once and drops leftover worker
 * databases; it is then only a template. Before each test file, the worker clones it (CREATE DATABASE … TEMPLATE)
 * into `<base>_w<VITEST_POOL_ID>_test` once and points TEST_DATABASE_URL at the clone, so every suite that reads
 * the variable gets its own worker's database. Files in one worker run one after another, as they did serially.
 *
 * Only a disposable localhost database whose name ends in `_test` is cloned (the role needs CREATEDB);
 * anything else keeps the shared database and then needs `--no-file-parallelism`.
 */
import pg from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function perWorkerEligible(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname) && /^\/[a-z0-9_]+_test$/.test(url.pathname) && process.env.RELO_TEST_DB_PER_WORKER !== "0";
}

const baseName = (url: URL) => url.pathname.slice(1);
export const workerDatabaseName = (base: string, worker: string) => `${base.slice(0, -"_test".length)}_w${worker}_test`;

/** A client on the cluster's maintenance database: nothing may be connected to the template while it is cloned. */
async function maintenance<T>(url: URL, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const target = new URL(url); target.pathname = "/postgres";
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Global setup: drop leftover worker databases so every run starts from the template as migrated now. */
export async function dropWorkerDatabases(url: URL): Promise<void> {
  const prefix = `${baseName(url).slice(0, -"_test".length)}_w`;
  await maintenance(url, async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE starts_with(datname, $1) AND datname ~ '_w[0-9]+_test$'", [prefix]);
    for (const { datname } of rows) await client.query(`DROP DATABASE IF EXISTS ${quote(datname)} WITH (FORCE)`);
  });
}

/** Worker setup: clone the template for this worker (once) and return the clone's URL. */
export async function workerDatabase(url: URL, worker: string): Promise<URL> {
  const base = baseName(url), name = workerDatabaseName(base, worker);
  await maintenance(url, async (client) => {
    if ((await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount) return;
    for (let attempt = 0; ; attempt++) {
      try {
        await client.query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(base)}`);
        break;
      } catch (error) {
        // Two workers cloning at the same instant can see each other on the template; wait and retry.
        if (attempt >= 20 || !/being accessed by other users/.test(String(error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 50));
      }
    }
    // A database-level grant is not copied by TEMPLATE; migration 0014 gives it to the runtime role.
    const runtime = await client.query("SELECT 1 FROM pg_roles WHERE rolname='relo_runtime'");
    if (runtime.rowCount) await client.query(`GRANT CONNECT ON DATABASE ${quote(name)} TO relo_runtime`);
  });
  const clone = new URL(url); clone.pathname = `/${name}`;
  return clone;
}
