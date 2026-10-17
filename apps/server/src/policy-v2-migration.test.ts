import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOwner } from "./bootstrap.js";
import { issueLogin } from "./credentials/login.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

/** Plan 11 phase 2: stored policies rewritten to {layout, colorStrategy, accentColor}; a failed parse is "no policy". */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const OLD_SHAPES: Array<{ name: string; old: Record<string, unknown>; expected: Record<string, unknown> }> = [
  { name: "automatic/thread", old: { preset: "automatic",theme: "system",symbol: "automatic",colorStrategy: "thread",accentColor: "#112233" },
    expected: { layout: "progress",colorStrategy: "project",accentColor: "#112233" } },
  { name: "standard/project", old: { preset: "standard",theme: "light",symbol: "code",colorStrategy: "project",accentColor: "#5ED8B7" },
    expected: { layout: "progress",colorStrategy: "project",accentColor: "#5ED8B7" } },
  { name: "terminal/fixed", old: { preset: "terminal",theme: "dark",symbol: "build",colorStrategy: "fixed",accentColor: "#AABBCC" },
    expected: { layout: "progress",colorStrategy: "fixed",accentColor: "#AABBCC" } },
  { name: "steps/fixed", old: { preset: "steps",theme: "system",symbol: "automatic",colorStrategy: "fixed",accentColor: "#FF6B57" },
    expected: { layout: "steps",colorStrategy: "fixed",accentColor: "#FF6B57" } },
];

suite("live activity policy v2 migration", () => {
  let db: Database;
  let principalId: string;
  beforeAll(async () => { db = createDatabase(databaseUrl!); await migrate(db); });
  beforeEach(async () => {
    await db.query("TRUNCATE account_identities, principal_api_keys, owner_principals, webhook_services CASCADE");
    await bootstrapOwner(db,"owner","policy_v2_owner_token_abcdefghijklmnopqrstuvwxyz");
    principalId = (await db.query<{ id: string }>("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0]!.id;
  });
  afterAll(async () => { await db.end(); });

  const migration = () => readFile(new URL("../migrations/0111_live_activity_policy_v2.sql",import.meta.url),"utf8");

  test("each old shape becomes the new shape in all three tables, (0112 later drops layout)", async () => {
    const keys: string[] = [];
    for (const [index,shape] of OLD_SHAPES.entries()) {
      const issued = await issueLogin(db,{ principalId,label: `mac ${index}`,scopes: ["notifications:send"],expiresAt: null });
      if (typeof issued === "string") throw new Error(issued);
      keys.push(issued.row.id);
      await db.query("UPDATE principal_api_keys SET live_activity_policy=$2 WHERE id=$1",[issued.row.id,shape.old]);
      await db.query(
        `INSERT INTO webhook_services(principal_id,title,secret_hash,secret_prefix,live_activity_policy) VALUES ($1,$2,$3,'hook_',$4)`,
        [principalId,`svc ${index}`,`hash-${index}`,shape.old],
      );
    }
    await db.query("UPDATE owner_principals SET live_activity_policy=$2 WHERE id=$1",[principalId,OLD_SHAPES[3]!.old]);
    await db.query(await migration());

    for (const [index,shape] of OLD_SHAPES.entries()) {
      const key = (await db.query("SELECT live_activity_policy AS p FROM principal_api_keys WHERE id=$1",[keys[index]])).rows[0].p;
      const service = (await db.query("SELECT live_activity_policy AS p FROM webhook_services WHERE title=$1",[`svc ${index}`])).rows[0].p;
      expect(key,shape.name).toEqual(shape.expected);
      expect(service,shape.name).toEqual(shape.expected);
    }
    const account = (await db.query("SELECT live_activity_policy AS p FROM owner_principals WHERE id=$1",[principalId])).rows[0].p;
    expect(account).toEqual(OLD_SHAPES[3]!.expected);
  });

  test("a row already in the new shape, and a null policy, are left alone", async () => {
    const issued = await issueLogin(db,{ principalId,label: "mac new",scopes: ["notifications:send"],expiresAt: null });
    if (typeof issued === "string") throw new Error(issued);
    const next = { layout: "steps",colorStrategy: "fixed",accentColor: "#123456" };
    await db.query("UPDATE principal_api_keys SET live_activity_policy=$2 WHERE id=$1",[issued.row.id,next]);
    await db.query(await migration());
    const row = (await db.query("SELECT live_activity_policy AS p FROM principal_api_keys WHERE id=$1",[issued.row.id])).rows[0];
    expect(row.p).toEqual(next);
    const account = (await db.query("SELECT live_activity_policy AS p FROM owner_principals WHERE id=$1",[principalId])).rows[0];
    expect(account.p).toBeNull();
  });
});
