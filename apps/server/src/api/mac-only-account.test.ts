import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { generateToken,hashToken } from "../auth.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { caller,resetOwner,SECRET } from "../works/works-fixture.js";

/**
 * An account whose only device is Relo for Mac (an owner overview device, owner-overview.ts): it shows
 * cards, questions and notices from Now, so each is accepted without any push target. An account with a
 * phone is unchanged: delivery goes to the phone only.
 */
const b64 = (bytes: number,fill = 7) => Buffer.alloc(bytes,fill).toString("base64url");
function envelope(kind: "notice" | "question",devices: string[]) {
  return { v: "relo.e2e.v1",kind,context: `ntf:${"0".repeat(32)}`,sender: `k_${"A".repeat(22)}`,
    recipients: devices.map((device,index) => ({ device,prekey: `pk_${index}`,enc: b64(65),key: b64(48) })),
    nonce: b64(12),ct: b64(256 + 16),sig: b64(64) };
}
const sealedTo = (kind: "notice" | "question",devices: string[]) =>
  ({ alerts: devices.map((device) => envelope(kind,[device])),content: envelope(kind,devices) });
const CONTEXT = { providerName: "Claude Code",project: "relo",threadName: "Release" };

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("an account whose only device is Relo for Mac",() => {
  let db: Database,app: ReturnType<typeof createApp>,call: ReturnType<typeof caller>;
  let principalId: string,phoneId: string,macId: string,mac: string;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET });
    call = caller(app);
  });
  afterAll(async () => db.end());

  beforeEach(async () => {
    ({ principalId,deviceId: phoneId } = await resetOwner(db));
    macId = randomUUID();
    await db.query(`INSERT INTO devices (id,principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
        os_version,model,apns_environment,notification_authorization,live_activity_authorization,credential_version,capabilities)
      VALUES ($1,$2,$3,$4,'Mac','com.example.relo.notch','1','1','26','Mac16,1','sandbox','denied','denied',1,
        ARRAY['choice_questions','owner_overview']::text[])`,[macId,principalId,`stable-${macId}`,randomUUID()]);
    mac = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[macId,hashToken(mac)]);
  });
  const removePhone = () => db.query("UPDATE devices SET revoked_at=now() WHERE id=$1",[phoneId]);

  async function as(token: string,method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      "idempotency-key": randomUUID() },body: body === undefined ? null : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  const jobs = async () => (await db.query<{ device_id: string }>("SELECT device_id FROM delivery_jobs ORDER BY device_id")).rows.map((row) => row.device_id);
  const startCard = (body: Record<string,unknown> = {}) =>
    call("POST","/api/live-activities",{ key: `mac-only-${randomUUID()}`,title: "Release",status: "Working",context: CONTEXT,...body },null);
  async function answerFromMac(interactionId: string) {
    const pending = await as(mac,"GET","/api/inbox/pending");
    expect(pending.status).toBe(200);
    const entry = pending.body.items.find((item: any) => item.interaction.id === interactionId);
    expect(entry,JSON.stringify(pending.body)).toBeDefined();
    const answered = await as(mac,"POST",`/api/notifications/${entry.notificationId}/interactions`,
      { kind: "approve",idempotencyKey: randomUUID(),expectedInteractionId: interactionId });
    expect(answered.status,JSON.stringify(answered.body)).toBe(201);
    expect((await db.query("SELECT state::text FROM interaction_requests WHERE id=$1",[interactionId.slice(4)])).rows[0].state).toBe("approved");
    return entry;
  }

  test("a card starts with no durable command and says the Mac reads it",async () => {
    await removePhone();
    const started = await startCard();
    expect(started.status,JSON.stringify(started.body)).toBe(201);
    expect(started.body.delivery).toMatchObject({ eligibleDevices: 0,durableCommands: 0,apnsJobs: 0,readers: 1 });
    expect((await db.query("SELECT target_device_ids FROM live_activities WHERE id=$1",[started.body.activity.id.slice(4)])).rows[0].target_device_ids).toEqual([]);
    const now = await as(mac,"GET","/api/now");
    expect(JSON.stringify(now.body)).toContain(started.body.activity.id);
  });

  test("a question on the card is created without a push target, listed and answered by the Mac",async () => {
    await removePhone();
    const started = await startCard();
    const asked = await call("POST",`/api/live-activities/${started.body.activity.id}/wait`,{ type: "approval",prompt: "Deploy now?",expiresInSeconds: 120 },null);
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.delivery).toMatchObject({ eligibleDevices: 0,apnsJobs: 0,readers: 1 });
    expect(await jobs()).toEqual([]);
    // The Mac holds the question's copy; the unseen-card fallback does not notify a phone that is not there.
    const events = (await db.query("SELECT e.id,t.device_id FROM notification_events e JOIN notification_event_targets t ON t.notification_event_id=e.id")).rows;
    expect(events.map((row) => row.device_id)).toEqual([macId]);
    await answerFromMac(asked.body.interaction.id);
  });

  test("a choice question on the card is answered by the Mac too",async () => {
    await removePhone();
    const started = await startCard();
    const asked = await call("POST",`/api/live-activities/${started.body.activity.id}/wait`,
      { type: "choice",prompt: "Which?",options: [{ id: "a",label: "A" },{ id: "b",label: "B" }],expiresInSeconds: 120 },null);
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    const pending = await as(mac,"GET","/api/inbox/pending");
    expect(pending.body.items).toHaveLength(1);
    expect(pending.body.items[0].interaction.options.map((option: any) => option.id)).toEqual(["a","b"]);
  });

  test("a notice or a question sealed to the Mac is accepted with no push, and the Mac reads its envelope",async () => {
    await removePhone();
    const macPublic = `dev_${macId}`;
    const notice = sealedTo("notice",[macPublic]);
    const sent = await call("POST","/api/notifications",{ sourceName: "Claude Code",context: CONTEXT,sealed: notice },null);
    expect(sent.status,JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.delivery).toMatchObject({ eligibleDevices: 0,apnsJobs: 0,readers: 1 });
    expect(await jobs()).toEqual([]);
    const detail = await as(mac,"GET",`/api/inbox/${sent.body.eventId}`);
    expect(detail.status,JSON.stringify(detail.body)).toBe(200);
    expect((detail.body.item ?? detail.body).sealed).toEqual({ alert: notice.alerts[0],content: notice.content });

    const question = sealedTo("question",[macPublic]);
    const asked = await call("POST","/api/interactions",{ type: "approval",context: CONTEXT,answerInApp: true,sealed: question },null);
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    const entry = await answerFromMac(asked.body.interaction.id);
    expect(entry.sealed).toEqual({ alert: question.alerts[0],content: question.content });
  });

  test("a plain question with no device named is created and answered by the Mac",async () => {
    await removePhone();
    const asked = await call("POST","/api/interactions",{ type: "approval",title: "Deploy",prompt: "Deploy now?",context: CONTEXT,answerInApp: true },null);
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    await answerFromMac(asked.body.interaction.id);
  });

  test("a question that is its own card falls to the Mac when no phone can show it",async () => {
    await removePhone();
    const asked = await call("POST","/api/interactions",{ type: "approval",title: "Deploy",prompt: "Deploy now?",context: CONTEXT,
      presentation: "live_activity" },null);
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.delivery).toMatchObject({ eligibleDevices: 0,apnsJobs: 0,readers: 1 });
    await answerFromMac(asked.body.interaction.id);
  });

  test("with a phone, push targets only the phone and a notice sealed to both is accepted",async () => {
    const macPublic = `dev_${macId}`,phonePublic = `dev_${phoneId}`;
    const sent = await call("POST","/api/notifications",{ sourceName: "Claude Code",context: CONTEXT,sealed: sealedTo("notice",[phonePublic,macPublic]) },null);
    expect(sent.status,JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.delivery).toMatchObject({ eligibleDevices: 1,readers: 1 });
    expect(await jobs()).toEqual([phoneId]);

    const started = await startCard();
    expect(started.body.delivery).toMatchObject({ eligibleDevices: 1,durableCommands: 1,readers: 1 });
    expect((await db.query("SELECT target_device_ids FROM live_activities WHERE id=$1",[started.body.activity.id.slice(4)])).rows[0].target_device_ids).toEqual([phoneId]);
    const asked = await call("POST",`/api/live-activities/${started.body.activity.id}/wait`,{ type: "approval",prompt: "Deploy now?",expiresInSeconds: 120 },null);
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    const copies = (await db.query("SELECT t.device_id FROM notification_events e JOIN notification_event_targets t ON t.notification_event_id=e.id JOIN interaction_requests r ON r.notification_event_id=e.id")).rows;
    expect(copies.map((row) => row.device_id)).toEqual([phoneId]);
    // A name that is neither an eligible phone nor an overview device is still refused.
    const stranger = await call("POST","/api/notifications",{ sourceName: "Claude Code",context: CONTEXT,
      sealed: sealedTo("notice",[`dev_${randomUUID()}`]) },null);
    expect(stranger.status).toBe(400);
  });

  test("the device inventory marks the Mac as an owner overview device, with no keys published",async () => {
    const listed = await call("GET","/api/devices",undefined,null);
    expect(listed.status,JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.devices.map((entry: any) => [entry.deviceId,entry.ownerOverview])).toEqual(
      expect.arrayContaining([[`dev_${macId}`,true],[`dev_${phoneId}`,undefined]]));
    // The key listing (an inner join on published keys) cannot see it: the inventory is what a local account's computer reads.
    const keys = await call("GET","/api/devices/keys",undefined,null);
    expect(keys.body.devices.map((entry: any) => entry.deviceId)).not.toContain(`dev_${macId}`);
  });

  test("the account's phones mark the Mac so it can leave it out of 'an iPhone is trusted'",async () => {
    const listed = await as(mac,"GET","/api/devices/self/devices");
    expect(listed.status,JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.devices.map((entry: any) => [entry.deviceId,entry.ownerOverview])).toEqual(
      expect.arrayContaining([[`dev_${macId}`,true],[`dev_${phoneId}`,undefined]]));
  });
});
