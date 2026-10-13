import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

/** The owner may cap how many cards one CLI login keeps open; agents' logins have no cap. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const token = "owner_cap_abcdefghijklmnopqrstuvwxyz_0123456789";

suite("card limit per login", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{ apnsMode: "disabled",credentialDerivationSecret: "test-only-card-limit-secret-0123456789abcdef" });
  });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await bootstrapOwner(db,"cap-owner",token);
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='cap-owner'")).rows[0].id;
    await db.query(`INSERT INTO devices (principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
      os_version,model,apns_environment,notification_authorization,live_activity_authorization,credential_version)
      VALUES ($1,'s','i','Phone','com.example.relo.notifications','1','1','18','iPhone','sandbox','authorized','authorized',1)`,[principalId]);
  });
  afterAll(async () => db.end());

  const call = (method: string,path: string,body?: unknown) => app.request(path,{
    method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json","idempotency-key": randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Like the CLI: join this key's running card, or start it.
  const start = (key: string) => call("POST","/api/live-activities",{ key,acquireMode: "ensure",title: "Export",status: "Running" });
  const limit = (cap: number | null) => db.query("UPDATE principal_api_keys SET max_active_cards=$2 WHERE token_hash=$1",
    [hashToken(token),cap]);

  test("a limited login opens no more cards than allowed, joins its own, and frees a slot when one ends", async () => {
    await limit(1);
    const first = await start("export-a");
    expect(first.status).toBe(201);
    const refused = await start("export-b");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "card_limit_reached",code: "CARD_LIMIT_REACHED" });
    expect((await start("export-a")).status).toBeLessThan(300);
    const card = (await first.json() as any).activity.id;
    expect((await call("POST",`/api/live-activities/${card}/end`,{ status: "Done" })).status).toBe(200);
    expect((await start("export-b")).status).toBe(201);
  });

  test("a question card counts too, while a notification question never does", async () => {
    await limit(1);
    expect((await start("export-a")).status).toBe(201);
    const card = await call("POST","/api/interactions",{ type: "approval",title: "Export",prompt: "Ship?",
      presentation: "live_activity",expiresInSeconds: 120 });
    expect(card.status).toBe(409);
    const notification = await call("POST","/api/interactions",{ type: "approval",title: "Export",prompt: "Ship?",expiresInSeconds: 120 });
    expect(notification.status).toBe(201);
  });

  test("no limit by default", async () => {
    for (const key of ["a","b","c","d"]) {
      const started = await start(`agent-${key}`);
      expect(started.status,await started.clone().text()).toBe(201);
    }
  });
});
