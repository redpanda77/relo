import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LOGIN_SCOPES, isScope, scopesFor } from "@relo/notification-contracts";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

/** Plan 10 M2: the registry is the only list of scopes, and every scope the server names is in it. */
const SOURCE = fileURLToPath(new URL(".", import.meta.url));
const SCOPE_LITERAL = /["'`]((?:notifications|interactions|activities|devices|services|device|inbox|presence|hooks|sessions):[a-z]+)["'`]/gu;
const sources = (directory: string): string[] => readdirSync(directory,{ withFileTypes: true }).flatMap((entry) => {
  const path = join(directory,entry.name);
  if (entry.isDirectory()) return entry.name === "test-support" ? [] : sources(path);
  return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".generated.ts") ? [path] : [];
});

describe("scope registry", () => {
  test("every scope the server names exists, and no module keeps its own list of scopes", () => {
    const unknown: string[] = [];
    const lists: string[] = [];
    for (const path of sources(SOURCE)) {
      readFileSync(path,"utf8").split("\n").forEach((line,index) => {
        const found = [...line.matchAll(SCOPE_LITERAL)].map((match) => match[1]!);
        for (const scope of found) if (!isScope(scope)) unknown.push(`${relative(SOURCE,path)}:${index + 1} ${scope}`);
        if (found.length > 1 && !/\|\|.*scopes\.has|scopes\.has.*(\|\||&&)/u.test(line)) lists.push(`${relative(SOURCE,path)}:${index + 1}`);
      });
    }
    expect(unknown).toEqual([]);
    expect(lists).toEqual([]);
  });
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("scope column defaults", () => {
  let db: Database;
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => { await db.end(); });

  test("new logins and phones get the registry's scopes for their kind", async () => {
    const defaults = await db.query<{ table_name: string; column_default: string }>(
      `SELECT table_name,column_default FROM information_schema.columns
       WHERE column_name='scopes' AND table_name IN ('principal_api_keys','device_credentials','webhook_services')`,
    );
    const parsed = (table: string) => [...defaults.rows.find((row) => row.table_name === table)!.column_default.matchAll(/'([^']+)'/gu)].map((match) => match[1]);
    expect(parsed("principal_api_keys")).toEqual([...LOGIN_SCOPES]);
    expect(parsed("device_credentials")).toEqual(scopesFor("device"));
    expect(parsed("webhook_services")).toEqual(scopesFor("service"));
  });
});
