import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { generateToken, hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase, type Database } from "./db.js";
import { InteractionChangeHub } from "./interaction-change-hub.js";
import { migrate } from "./migrate.js";

/** `relo listen`: every settled question this credential asked, in order, resumable by cursor. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const secret = "test-only-answers-stream-secret-0123456789abcdef";
const token = "owner_stream_abcdefghijklmnopqrstuvwxyz_0123456789";

suite("answer stream", () => {
  let db: Database;
  let hub: InteractionChangeHub;
  let app: ReturnType<typeof createApp>;
  let phone: string;
  let otherKey: string;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
    hub = await InteractionChangeHub.listen(db);
    app = createApp(db,{ apnsMode: "disabled",credentialDerivationSecret: secret,interactionChanges: hub });
  });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await bootstrapOwner(db,"stream-owner",token);
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='stream-owner'")).rows[0].id;
    const deviceId = randomUUID();
    await db.query(
      `INSERT INTO devices (id,principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,model,apns_environment,notification_authorization,live_activity_authorization,credential_version)
       VALUES ($1,$2,$3,$4,'Phone','com.example.relo.notifications','1','1','18','iPhone','sandbox','authorized','authorized',1)`,
      [deviceId,principalId,`stable-${deviceId}`,randomUUID()]);
    phone = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[deviceId,hashToken(phone)]);
    otherKey = `other_${"k".repeat(40)}`;
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash) VALUES ($1,'other app',$2)",[principalId,hashToken(otherKey)]);
  });
  afterAll(async () => { await hub.close(); await db.end(); });

  const call = (method: string,path: string,body?: unknown,as = token) => app.request(path,{
    method,headers: { authorization: `Bearer ${as}`,"content-type": "application/json","idempotency-key": randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function ask(prompt: string,as = token): Promise<{ id: string; eventId: string }> {
    const response = await call("POST","/api/interactions",{ type: "yes_no",title: "Stream",prompt,
      correlationId: `corr-${prompt}`,expiresInSeconds: 300 },as);
    expect(response.status,await response.clone().text()).toBe(201);
    const body = await response.json() as any;
    return { id: body.interaction.id,eventId: body.eventId };
  }
  const answer = (question: { eventId: string },kind: "yes" | "no") => call("POST",`/api/notifications/${question.eventId}/interactions`,
    { kind,value: {},idempotencyKey: `a-${randomUUID()}` },phone);
  const read = async (query: string,as = token) => {
    const response = await call("GET",`/api/interactions/answers?${query}`,undefined,as);
    expect(response.status,await response.clone().text()).toBe(200);
    return response.json() as Promise<any>;
  };

  test("answers arrive in order with a cursor, and only for the credential that asked", async () => {
    const since = new Date(Date.now() - 1_000).toISOString();
    const first = await ask("one");
    const second = await ask("two");
    const notMine = await ask("three",otherKey);
    await answer(first,"yes");
    await answer(notMine,"no");
    const page = await read(`since=${encodeURIComponent(since)}&timeoutSeconds=0`);
    expect(page.answers.map((item: any) => [item.id,item.state,item.correlationId])).toEqual([[first.id,"yes","corr-one"]]);
    expect(page.cursor).toBe(page.answers[0].cursor);
    expect((await read(`after=${page.cursor}&timeoutSeconds=0`)).answers).toEqual([]);
    await answer(second,"no");
    const next = await read(`after=${page.cursor}&timeoutSeconds=0`);
    expect(next.answers.map((item: any) => [item.id,item.state])).toEqual([[second.id,"no"]]);
    expect((await read(`since=${encodeURIComponent(since)}&timeoutSeconds=0`,otherKey)).answers.map((item: any) => item.id))
      .toEqual([notMine.id]);
  });

  test("without a position the stream starts now; a bad cursor is refused", async () => {
    const old = await ask("old");
    await answer(old,"yes");
    expect((await read("timeoutSeconds=0")).answers).toEqual([]);
    expect((await call("GET","/api/interactions/answers?after=not-a-cursor")).status).toBe(400);
  });

  test("a waiting reader wakes as soon as an answer lands", async () => {
    const question = await ask("wake");
    const start = await read("timeoutSeconds=0");
    const started = performance.now();
    const waiting = read(`after=${start.cursor}&timeoutSeconds=20`);
    await new Promise((resolve) => setTimeout(resolve,300));
    await answer(question,"yes");
    const woke = await waiting;
    expect(woke.answers.map((item: any) => item.id)).toEqual([question.id]);
    expect(performance.now() - started).toBeLessThan(15_000);
  });
});
