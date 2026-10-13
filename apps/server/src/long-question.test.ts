import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { generateToken, hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { createTransportTokenEncryption } from "./token-encryption.js";

/** A question may wait longer than its card lives: the same decision continues quietly in Relo. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const secret = "test-only-long-question-secret-0123456789abcdef";
const token = "owner_long_q_abcdefghijklmnopqrstuvwxyz_0123456789";
const DAY = 86_400;

suite("long questions", () => {
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
    await db.query("UPDATE server_settings SET max_question_seconds=604800");
    await bootstrapOwner(db,"long-owner",token);
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='long-owner'")).rows[0].id;
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
  afterAll(async () => {
    await db.query("UPDATE server_settings SET max_question_seconds=604800");
    await db.end();
  });

  const call = (method: string,path: string,body?: unknown,as = token) => app.request(path,{
    method,headers: { authorization: `Bearer ${as}`,"content-type": "application/json","idempotency-key": randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function json(response: Response,status: number): Promise<any> {
    const text = await response.text();
    expect(response.status,text).toBe(status);
    return JSON.parse(text);
  }
  async function card(): Promise<string> {
    return (await json(await call("POST","/api/live-activities",{ key: `work-${randomUUID()}`,title: "Release",status: "Working" }),201))
      .activity.id;
  }
  async function group(interactionId: string) {
    return (await db.query(
      `SELECT r.id,r.state,r.expires_at,e.kind,e.id AS event_id,
         (SELECT count(*)::int FROM delivery_jobs j WHERE j.notification_event_id=e.id) AS jobs
       FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
       WHERE r.decision_group_id=(SELECT decision_group_id FROM interaction_requests WHERE id=$1)
       ORDER BY r.expires_at`,[interactionId.slice(4)])).rows;
  }
  const hoursLeft = (at: Date) => (at.getTime() - Date.now()) / 3_600_000;

  test("a question that outlives its card keeps waiting as a quiet notification of the same decision", async () => {
    const asked = await json(await call("POST",`/api/live-activities/${await card()}/wait`,
      { type: "approval",prompt: "Ship tonight's build?",expiresInSeconds: 2 * DAY }),201);
    expect(hoursLeft(new Date(asked.interaction.expiresAt))).toBeGreaterThan(47);
    const members = await group(asked.interaction.id);
    expect(members).toHaveLength(2);
    const [onCard,waiting] = members;
    expect(onCard).toMatchObject({ kind: "live_activity",state: "pending" });
    expect(hoursLeft(onCard.expires_at)).toBeLessThanOrEqual(8);
    expect(waiting).toMatchObject({ kind: "approval",state: "pending",jobs: 0 });
    expect(`int_${waiting.id}`).toBe(asked.interaction.id);

    const pending = JSON.stringify(await json(await call("GET","/api/inbox/pending",undefined,phone),200));
    expect(pending).toContain(`ntf_${waiting.event_id}`);
    expect(pending).not.toContain(`ntf_${onCard.event_id}`);
  });

  test("answering on the card decides the waiting question too", async () => {
    const asked = await json(await call("POST",`/api/live-activities/${await card()}/wait`,
      { type: "yes_no",prompt: "Keep the preview?",expiresInSeconds: DAY }),201);
    const [onCard] = await group(asked.interaction.id);
    await json(await call("POST",`/api/notifications/ntf_${onCard.event_id}/interactions`,
      { kind: "yes",value: {},idempotencyKey: `answer-${randomUUID()}` },phone),201);
    const result = await json(await call("GET",`/api/interactions/${asked.interaction.id}`),200);
    expect(result.interaction.state).toBe("yes");
  });

  test("answering in Relo after the card ends settles the card's question", async () => {
    const asked = await json(await call("POST",`/api/live-activities/${await card()}/wait`,
      { type: "approval",prompt: "Ship tonight's build?",expiresInSeconds: DAY }),201);
    const [,waiting] = await group(asked.interaction.id);
    await json(await call("POST",`/api/notifications/ntf_${waiting.event_id}/interactions`,
      { kind: "deny",value: {},idempotencyKey: `answer-${randomUUID()}` },phone),201);
    expect((await group(asked.interaction.id)).map((member: any) => member.state)).toEqual(["denied","denied"]);
  });

  test("a question within the card's life stays one card question", async () => {
    const asked = await json(await call("POST",`/api/live-activities/${await card()}/wait`,
      { type: "approval",prompt: "Ship?",expiresInSeconds: 3_600 }),201);
    expect((await db.query("SELECT decision_group_id FROM interaction_requests WHERE id=$1",
      [asked.interaction.id.slice(4)])).rows[0].decision_group_id).toBeNull();
  });

  test("the admin's limit bounds every way of asking; five minutes is always allowed", async () => {
    await db.query("UPDATE server_settings SET max_question_seconds=3600");
    const id = await card();
    const refused = await json(await call("POST",`/api/live-activities/${id}/wait`,
      { type: "approval",prompt: "Ship?",expiresInSeconds: 7_200 }),400);
    expect(refused).toMatchObject({ error: "question_wait_too_long",maximumSeconds: 3_600 });
    expect(refused.message).toContain("1 hour");
    await json(await call("POST","/api/interactions",
      { type: "approval",title: "Release",prompt: "Ship?",expiresInSeconds: 7_200 }),400);
    await json(await call("POST",`/api/live-activities/${id}/wait`,
      { type: "approval",prompt: "Ship?",expiresInSeconds: 300 }),201);
    expect((await call("POST","/api/interactions",
      { type: "approval",title: "Release",prompt: "Ship?",expiresInSeconds: 40 * DAY })).status).toBe(400);
  });

  test("a notification question can wait days when the server allows it", async () => {
    const asked = await json(await call("POST","/api/interactions",
      { type: "approval",title: "Release",prompt: "Ship 2.0?",expiresInSeconds: 3 * DAY }),201);
    const row = (await db.query("SELECT expires_at FROM interaction_requests WHERE id=$1",[asked.interaction.id.slice(4)])).rows[0];
    expect(hoursLeft(row.expires_at)).toBeGreaterThan(71);
  });
});
