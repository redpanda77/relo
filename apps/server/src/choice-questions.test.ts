import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { generateToken, hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase, type Database } from "./db.js";
import { callbackPayload } from "./interaction-callbacks.js";
import { migrate } from "./migrate.js";
import { createWebhookService } from "./webhooks/admin.js";
import { createTransportTokenEncryption } from "./token-encryption.js";

/** docs/CHOICE-QUESTIONS.md: 2-4 options, only to phones that can show them. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const secret = "test-only-choice-questions-secret-0123456789abcdef";
const token = "owner_choice_abcdefghijklmnopqrstuvwxyz_0123456789";
const options = [{ id: "ship",label: "Ship" },{ id: "wait",label: "Wait" },{ id: "rollback",label: "Roll back" }];

type Phone = { id: string; credential: string };

suite("choice questions", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let principalId: string;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });
  });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await bootstrapOwner(db,"choice-owner",token);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='choice-owner'")).rows[0].id;
  });
  afterAll(async () => db.end());

  async function phone(name: string,capabilities: string[]): Promise<Phone> {
    const id = randomUUID();
    const encryption = createTransportTokenEncryption(secret);
    await db.query(
      `INSERT INTO devices (id,principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,model,apns_environment,apns_token,live_activity_push_to_start_token,notification_authorization,
         live_activity_authorization,credential_version,capabilities)
       VALUES ($1,$2,$3,$4,$5,'com.example.relo.notifications','1','1','18','iPhone','sandbox',$6,$7,
         'authorized','authorized',1,$8::text[])`,
      [id,principalId,`stable-${id}`,randomUUID(),name,encryption.encrypt("a".repeat(64),"device.apns_token"),
        encryption.encrypt("b".repeat(64),"device.live_activity_push_to_start_token"),capabilities]);
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[id,hashToken(credential)]);
    return { id: `dev_${id}`,credential };
  }
  const call = (method: string,path: string,body?: unknown,as = token) => app.request(path,{
    method,headers: { authorization: `Bearer ${as}`,"content-type": "application/json","idempotency-key": randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function json(response: Response,status: number): Promise<any> {
    const text = await response.text();
    expect(response.status,text).toBe(status);
    return JSON.parse(text);
  }
  async function cardFor(...phones: Phone[]): Promise<string> {
    return (await json(await call("POST","/api/live-activities",{ key: `work-${randomUUID()}`,title: "Release",
      status: "Working",deviceIds: phones.map((device) => device.id) }),201)).activity.id;
  }
  const choose = (as: Phone,eventId: string,optionId: unknown) => call("POST",`/api/notifications/${eventId}/interactions`,
    { kind: "choose",value: { optionId },idempotencyKey: `choose-${randomUUID()}` },as.credential);

  test("a phone declares what it can show on check-in", async () => {
    const device = await phone("Phone",[]);
    await json(await call("PUT",`/api/devices/${device.id}`,{ capabilities: ["choice_questions"] },device.credential),200);
    expect((await db.query("SELECT capabilities FROM devices WHERE id=$1",[device.id.slice(4)])).rows[0].capabilities)
      .toEqual(["choice_questions"]);
    expect((await call("PUT",`/api/devices/${device.id}`,{ capabilities: ["telepathy"] },device.credential)).status).toBe(400);
  });

  test("a question with options lands on the card and is answered with one of them", async () => {
    const device = await phone("New iPhone",["choice_questions"]);
    const card = await cardFor(device);
    const asked = await json(await call("POST",`/api/live-activities/${card}/wait`,
      { type: "choice",prompt: "Which release?",options,expiresInSeconds: 120 }),201);
    const eventId = asked.eventId;
    const command = (await db.query("SELECT payload FROM notification_events WHERE id=$1",[eventId.slice(4)])).rows[0].payload.liveActivity;
    expect(command).toMatchObject({ behaviorType: "choice",choiceOptions: options,subtitle: "Which release?" });

    const pending = await json(await call("GET","/api/inbox/pending",undefined,device.credential),200);
    expect(pending.items[0].interaction).toMatchObject({ type: "choice",options });
    const current = await json(await call("GET","/api/inbox/current",undefined,device.credential),200);
    expect(JSON.stringify(current)).toContain('"options"');

    // The database refuses a choice without its options, whatever writes it.
    await expect(db.query("UPDATE interaction_requests SET options=NULL WHERE notification_event_id=$1",[eventId.slice(4)]))
      .rejects.toThrow(/choice_has_options/u);

    expect((await choose(device,eventId,"nope")).status).toBe(400);
    expect((await choose(device,eventId,"ship")).status).toBeLessThan(300);

    const result = await json(await call("GET",`/api/interactions/${asked.interaction.id}`),200);
    expect(result.interaction).toMatchObject({ type: "choice",options,state: "replied",action: "choose",
      response: { optionId: "ship",label: "Ship" } });
    const item = await json(await call("GET",`/api/inbox/${eventId}`,undefined,device.credential),200);
    expect((item.item ?? item).interaction).toMatchObject({ kind: "choice",response: { optionId: "ship",label: "Ship" } });
    const ended = (await db.query("SELECT status FROM live_activities WHERE id=$1",[card.slice(4)])).rows[0];
    expect(ended.status).toContain("Ship");
    // The phone's sync reads the snapshot and rejects a choice without its options: one such item failed the whole
    // sync and the inbox read as offline. The snapshot carries the options and the chosen one, like the detail.
    const snapshot = await json(await call("GET","/api/inbox/snapshot",undefined,device.credential),200);
    const summary = snapshot.items.find((entry: any) => entry.id === eventId);
    expect(summary.interaction).toMatchObject({ kind: "choice",options,response: { optionId: "ship",label: "Ship" } });
    const others = snapshot.items.filter((entry: any) => entry.interaction && entry.interaction.kind !== "choice");
    for (const other of others) expect(other.interaction).not.toHaveProperty("options");
  });

  test("a signed choice keeps the phone's signature with the option (E4.2)", async () => {
    const device = await phone("Signing iPhone",["choice_questions"]);
    const card = await cardFor(device);
    const asked = await json(await call("POST",`/api/live-activities/${card}/wait`,
      { type: "choice",prompt: "Which release?",options,expiresInSeconds: 120 }),201);
    const signature = { e2eeKeyId: `k_${"A".repeat(22)}`,e2eeSignedAt: "2026-10-13T17:00:00.000Z",
      e2eeSignature: Buffer.alloc(64,7).toString("base64url") };
    const send = (value: Record<string,unknown>) => call("POST",`/api/notifications/${asked.eventId}/interactions`,
      { kind: "choose",value,idempotencyKey: `choose-${randomUUID()}` },device.credential);
    expect((await send({ optionId: "ship",e2eeKeyId: "not-a-key" })).status).toBe(400);
    expect((await send({ optionId: "ship",...signature })).status).toBeLessThan(300);
    const result = await json(await call("GET",`/api/interactions/${asked.interaction.id}`),200);
    expect(result.interaction.response).toEqual({ optionId: "ship",label: "Ship",...signature });
  });

  test("a phone that cannot show options never gets one", async () => {
    const newPhone = await phone("New iPhone",["choice_questions"]);
    const oldPhone = await phone("Old iPhone",[]);
    const refused = await json(await call("POST",`/api/live-activities/${await cardFor(newPhone,oldPhone)}/wait`,
      { type: "choice",prompt: "Which release?",options,expiresInSeconds: 120 }),409);
    expect(refused).toMatchObject({ error: "choice_unsupported",devices: ["Old iPhone"] });
    expect(refused.message).toContain("Update Relo on Old iPhone");

    const notified = await json(await call("POST","/api/interactions",
      { type: "choice",title: "Release",prompt: "Which release?",options,expiresInSeconds: 120 }),201);
    const targets = (await db.query("SELECT device_id FROM notification_event_targets WHERE notification_event_id=$1",
      [notified.eventId.slice(4)])).rows.map((row: any) => `dev_${row.device_id}`);
    expect(targets).toEqual([newPhone.id]);
    const oldView = JSON.stringify(await json(await call("GET","/api/inbox/history",undefined,oldPhone.credential),200));
    expect(oldView).not.toContain(notified.eventId);
    expect(JSON.stringify(await json(await call("GET","/api/inbox/pending",undefined,oldPhone.credential),200)))
      .not.toContain("choice");

    const named = await call("POST","/api/interactions",{ type: "choice",title: "Release",prompt: "Which release?",
      options,expiresInSeconds: 120,deviceIds: [oldPhone.id] });
    expect(named.status).toBe(409);
  });

  test("with no phone able to show options, nothing is created", async () => {
    await phone("Old iPhone",[]);
    const before = Number((await db.query("SELECT count(*) FROM interaction_requests")).rows[0].count);
    const refused = await json(await call("POST","/api/interactions",
      { type: "choice",title: "Release",prompt: "Which release?",options,expiresInSeconds: 120 }),409);
    expect(refused.error).toBe("choice_unsupported");
    expect(Number((await db.query("SELECT count(*) FROM interaction_requests")).rows[0].count)).toBe(before);
  });

  test("options are validated", async () => {
    const card = await cardFor(await phone("New iPhone",["choice_questions"]));
    const ask = (body: Record<string,unknown>) => call("POST",`/api/live-activities/${card}/wait`,
      { prompt: "Which?",expiresInSeconds: 120,...body });
    for (const body of [
      { type: "choice" },
      { type: "choice",options: [options[0]] },
      { type: "choice",options: [...options,{ id: "d",label: "D" },{ id: "e",label: "E" }] },
      { type: "choice",options: [{ id: "a",label: "Same" },{ id: "b",label: "same" }] },
      { type: "choice",options: [{ id: "Bad Id",label: "A" },{ id: "b",label: "B" }] },
      { type: "choice",options,primaryLabel: "Go" },
      { type: "approval",options },
    ]) expect((await ask(body)).status,JSON.stringify(body)).toBe(400);
  });

  test("a webhook service can ask with options and read which one was picked", async () => {
    const device = await phone("New iPhone",["choice_questions"]);
    const service = await createWebhookService(db,principalId,"CI","http://127.0.0.1:8180");
    const hook = "/hooks";
    const auth = { authorization: `Bearer ${service.secret}` };
    const sent = await json(await app.request(hook,{ method: "POST",headers: { "content-type": "application/json",...auth },
      body: JSON.stringify({ title: "Deploy",body: "Which release?",context: { project: "CI",threadName: "Deploys" },
        response: { type: "choice",options,expiresInSeconds: 120 } }) }),201);
    expect((await choose(device,sent.eventId,"rollback")).status).toBeLessThan(300);
    const read = await json(await app.request(`${hook}/events/${sent.eventId}`,{ headers: auth }),200);
    expect(read.event.response).toMatchObject({ status: "replied",action: "choose",optionId: "rollback",label: "Roll back" });
  });

  test("an answer callback names the option", () => {
    expect(callbackPayload({ interaction_request_id: randomUUID(),notification_event_id: randomUUID(),correlation_id: null,
      kind: "choice",request_state: "replied",response: { optionId: "wait",label: "Wait" },responded_at: new Date() }))
      .toMatchObject({ kind: "choice",status: "replied",action: "choose",optionId: "wait",label: "Wait" });
  });
});
