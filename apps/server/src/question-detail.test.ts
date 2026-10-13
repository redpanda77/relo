import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { generateToken, hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { createTransportTokenEncryption } from "./token-encryption.js";

/** A question is one Lock Screen line; its detail is read in Relo and stored encrypted. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const secret = "test-only-question-detail-secret-0123456789abcdef";
const token = "owner_detail_abcdefghijklmnopqrstuvwxyz_0123456789";
const detail = "**Why:** the migration rewrites 2 tables.\n\n- Risk: 30s of read-only time\n- Undo: `relo rollback`";

suite("question detail", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let phone: string;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });
  });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await bootstrapOwner(db,"detail-owner",token);
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='detail-owner'")).rows[0].id;
    const deviceId = randomUUID();
    const encryption = createTransportTokenEncryption(secret);
    await db.query(
      `INSERT INTO devices (id,principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,model,apns_environment,apns_token,live_activity_push_to_start_token,notification_authorization,
         live_activity_authorization,credential_version)
       VALUES ($1,$2,$3,$4,'Phone','com.example.relo.notifications','1','1','18','iPhone','sandbox',$5,$6,
         'authorized','authorized',1)`,
      [deviceId,principalId,`stable-${deviceId}`,randomUUID(),encryption.encrypt("a".repeat(64),"device.apns_token"),
        encryption.encrypt("b".repeat(64),"device.live_activity_push_to_start_token")]);
    phone = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[deviceId,hashToken(phone)]);
  });
  afterAll(async () => db.end());

  const call = (method: string,path: string,body?: unknown,as = token) => app.request(path,{
    method,headers: { authorization: `Bearer ${as}`,"content-type": "application/json","idempotency-key": randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function card(): Promise<string> {
    const started = await call("POST","/api/live-activities",{ key: `work-${randomUUID()}`,title: "Release",status: "Working" });
    expect(started.status).toBe(201);
    return (await started.json() as any).activity.id;
  }
  /** What the phone shows for a question event: its summary and readable body. */
  async function onPhone(eventId: string) {
    const response = await call("GET",`/api/inbox/${eventId}`,undefined,phone);
    expect(response.status,await response.clone().text()).toBe(200);
    return (await response.json() as any).item?.content ?? (await response.json() as any).content;
  }
  async function storedCiphertext(eventId: string): Promise<string> {
    return (await db.query("SELECT body_ciphertext FROM notification_contents WHERE notification_event_id=$1",
      [eventId.slice(4)])).rows[0]?.body_ciphertext;
  }

  test("a card question is one line of at most 120 characters", async () => {
    const id = await card();
    const tooLong = await call("POST",`/api/live-activities/${id}/wait`,{ type: "approval",prompt: "x".repeat(121),expiresInSeconds: 120 });
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(await tooLong.json())).toContain("at most 120 characters; put the rest in detail");
    const twoLines = await call("POST",`/api/live-activities/${id}/wait`,{ type: "approval",prompt: "Ship?\nNow",expiresInSeconds: 120 });
    expect(twoLines.status).toBe(400);
    const fits = await call("POST",`/api/live-activities/${id}/wait`,{ type: "approval",prompt: "x".repeat(120),expiresInSeconds: 120 });
    expect(fits.status,await fits.clone().text()).toBe(201);
  });

  test("the detail of a card question reaches the phone and is encrypted at rest", async () => {
    const id = await card();
    const asked = await call("POST",`/api/live-activities/${id}/wait`,
      { type: "approval",prompt: "Run the migration now?",detail,expiresInSeconds: 120 });
    expect(asked.status,await asked.clone().text()).toBe(201);
    const { eventId } = await asked.json() as any;
    expect(await onPhone(eventId)).toMatchObject({ summary: "Run the migration now?",body: detail,format: "markdown" });
    const ciphertext = await storedCiphertext(eventId);
    expect(ciphertext).toBeTruthy();
    expect(ciphertext).not.toContain("migration");
  });

  test("a question card from the interactions API carries the detail too", async () => {
    const asked = await call("POST","/api/interactions",{ type: "approval",title: "Release",prompt: "Ship 1.2?",detail,
      presentation: "live_activity",expiresInSeconds: 120 });
    expect(asked.status,await asked.clone().text()).toBe(201);
    const { eventId } = await asked.json() as any;
    expect(await onPhone(eventId)).toMatchObject({ summary: "Ship 1.2?",body: detail,format: "markdown" });
  });

  test("a notification question reads as the question, then the detail", async () => {
    const asked = await call("POST","/api/interactions",{ type: "yes_no",title: "Release",prompt: "Ship 1.2?",detail,expiresInSeconds: 120 });
    expect(asked.status,await asked.clone().text()).toBe(201);
    const { eventId } = await asked.json() as any;
    expect(await onPhone(eventId)).toMatchObject({ summary: "Ship 1.2?",body: `Ship 1.2?\n\n${detail}`,format: "markdown" });
  });

  test("detail is bounded", async () => {
    const id = await card();
    const response = await call("POST",`/api/live-activities/${id}/wait`,
      { type: "approval",prompt: "Ship?",detail: "x".repeat(4_001),expiresInSeconds: 120 });
    expect(response.status).toBe(400);
  });
});
