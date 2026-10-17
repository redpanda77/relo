import { liveActivityPresentationPolicySchema } from "@relo/notification-contracts";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOwner } from "./bootstrap.js";
import { issueLogin } from "./credentials/login.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

/** Plan 11 D5: `layout` is stripped from every stored policy; a strict-parse failure would mean "no policy". */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("live activity policy drops layout migration", () => {
  let db: Database;
  let principalId: string;
  beforeAll(async () => { db = createDatabase(databaseUrl!); await migrate(db); });
  beforeEach(async () => {
    await db.query("TRUNCATE account_identities, principal_api_keys, owner_principals, webhook_services CASCADE");
    await bootstrapOwner(db,"owner","policy_drop_layout_owner_token_abcdefghijklmnopqrstuvwxyz");
    principalId = (await db.query<{ id: string }>("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0]!.id;
  });
  afterAll(async () => { await db.end(); });

  const migration = () => readFile(new URL("../migrations/0112_policy_drop_layout.sql",import.meta.url),"utf8");

  test("layout is removed in all three tables, the rest is kept, and the result parses", async () => {
    const issued = await issueLogin(db,{ principalId,label: "mac",scopes: ["notifications:send"],expiresAt: null });
    if (typeof issued === "string") throw new Error(issued);
    const old = { layout: "steps",colorStrategy: "fixed",accentColor: "#123456" };
    const expected = { colorStrategy: "fixed",accentColor: "#123456" };
    await db.query("UPDATE principal_api_keys SET live_activity_policy=$2 WHERE id=$1",[issued.row.id,old]);
    await db.query(
      `INSERT INTO webhook_services(principal_id,title,secret_hash,secret_prefix,live_activity_policy) VALUES ($1,'svc','hash-1','hook_',$2)`,
      [principalId,old],
    );
    await db.query("UPDATE owner_principals SET live_activity_policy=$2 WHERE id=$1",[principalId,old]);
    await db.query(await migration());
    const key = (await db.query("SELECT live_activity_policy AS p FROM principal_api_keys WHERE id=$1",[issued.row.id])).rows[0].p;
    const service = (await db.query("SELECT live_activity_policy AS p FROM webhook_services WHERE title='svc'")).rows[0].p;
    const account = (await db.query("SELECT live_activity_policy AS p FROM owner_principals WHERE id=$1",[principalId])).rows[0].p;
    for (const row of [key,service,account]) {
      expect(row).toEqual(expected);
      expect(liveActivityPresentationPolicySchema.safeParse(row).success).toBe(true);
    }
  });

  test("a policy without layout and a null policy are left alone", async () => {
    const next = { colorStrategy: "project",accentColor: "#5ED8B7" };
    await db.query("UPDATE owner_principals SET live_activity_policy=$2 WHERE id=$1",[principalId,next]);
    const issued = await issueLogin(db,{ principalId,label: "mac",scopes: ["notifications:send"],expiresAt: null });
    if (typeof issued === "string") throw new Error(issued);
    await db.query(await migration());
    expect((await db.query("SELECT live_activity_policy AS p FROM owner_principals WHERE id=$1",[principalId])).rows[0].p).toEqual(next);
    expect((await db.query("SELECT live_activity_policy AS p FROM principal_api_keys WHERE id=$1",[issued.row.id])).rows[0].p).toBeNull();
  });
});
