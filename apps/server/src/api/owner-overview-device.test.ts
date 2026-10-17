import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { nowSummarySchema,type NowItem,type NowSummary } from "@relo/notification-contracts";
import { createApp } from "../app.js";
import { generateToken,hashToken } from "../auth.js";
import { createDatabase,type Database } from "../db.js";
import { approveDevice,pendingDevices } from "../device-approvals.js";
import { listDeviceKeys } from "../device-keys.js";
import { migrate } from "../migrate.js";
import { caller,resetOwner,SECRET,startWork } from "../works/works-fixture.js";

/**
 * An owner overview device (docs/CHOICE-QUESTIONS.md, "Device capabilities"): the Mac's notch app
 * reads the whole account's Now and answers the copy the asker waits on, yet is never a delivery target.
 */
const b64 = (bytes: number,fill = 7) => Buffer.alloc(bytes,fill).toString("base64url");
function envelope(kind: "card" | "question",devices: string[],alert = false) {
  return { v: "relo.e2e.v1",kind,context: `ntf:${"0".repeat(32)}`,sender: `k_${"A".repeat(22)}`,
    recipients: devices.map((device,index) => ({ device,prekey: `pk_${index}`,enc: b64(65),key: b64(48) })),
    nonce: b64(12),ct: b64(256 + 16,alert ? 1 : 2),sig: b64(64) };
}
const notice = (kind: "card" | "question",alerted: string[],readers: string[] = []) => ({
  alerts: alerted.map((device) => envelope(kind,[device],true)),content: envelope(kind,[...alerted,...readers]),
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("an owner overview device",() => {
  let db: Database,app: ReturnType<typeof createApp>,call: ReturnType<typeof caller>;
  let principalId: string,phoneId: string,macId: string,secondId: string,mac: string,phone: string;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET });
    call = caller(app);
  });
  afterAll(async () => db.end());

  async function device(name: string,model: string,capabilities: string[],liveActivities: "authorized" | "denied") {
    const id = randomUUID();
    await db.query(`INSERT INTO devices (id,principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
        os_version,model,apns_environment,notification_authorization,live_activity_authorization,credential_version,capabilities)
      VALUES ($1,$2,$3,$4,$5,'com.example.relo.notifications','1','1','26',$6,'sandbox',$7,$7,1,$8::text[])`,
    [id,principalId,`stable-${id}`,randomUUID(),name,model,liveActivities,capabilities]);
    const token = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[id,hashToken(token)]);
    return { id,token };
  }
  beforeEach(async () => {
    ({ principalId,deviceId: phoneId } = await resetOwner(db));
    phone = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[phoneId,hashToken(phone)]);
    ({ id: macId,token: mac } = await device("Mac","Mac16,1",["choice_questions","owner_overview"],"denied"));
  });

  async function as(token: string,method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  const now = async (token: string): Promise<NowSummary> => {
    const read = await as(token,"GET","/api/now");
    expect(read.status,JSON.stringify(read.body)).toBe(200);
    return nowSummarySchema.parse(read.body);
  };
  const items = (summary: NowSummary): NowItem[] =>
    [...summary.needsYou,...summary.recent,...summary.waitingOnYou,...summary.running,...summary.quiet,...summary.paused];
  const raw = (id: string) => id.replace(/^[a-z]+_/,"");

  async function askedWork() {
    const work = await startWork(call);
    const asked = await call("POST",`/api/live-activities/${work.card.id}/wait`,{ type: "approval",prompt: "Deploy now?",expiresInSeconds: 120 },null);
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    return { cardId: work.card.id as string,askedId: asked.body.interaction?.id as string | undefined };
  }
  const copies = async () => (await db.query<{ id: string; notification_event_id: string }>(
    "SELECT id,notification_event_id FROM interaction_requests ORDER BY created_at,id")).rows;

  test("sees the account's Now, though it is never a target, and only envelopes sealed to it",async () => {
    const { cardId } = await askedWork();
    const targets = (await db.query("SELECT target_device_ids FROM live_activities WHERE id=$1",[raw(cardId)])).rows[0].target_device_ids;
    expect(targets).toEqual([phoneId]);
    const item = items(await now(mac)).find((entry) => entry.id === cardId);
    expect(item?.question?.standing).toBe("pending");
    expect(item?.notificationId).toMatch(/^ntf_/);
    // A phone that is not a target still sees nothing of it.
    const other = await device("Old phone","iPhone18,1",["choice_questions"],"denied");
    expect(items(await now(other.token)).find((entry) => entry.id === cardId)).toBeUndefined();

    expect(item).not.toHaveProperty("sealed");
    const card = notice("card",[`dev_${phoneId}`],[`dev_${macId}`]);
    await db.query("UPDATE live_activities SET sealed=$2 WHERE id=$1",[raw(cardId),card]);
    expect(items(await now(mac)).find((entry) => entry.id === cardId)!.sealed).toEqual({ card: card.content,question: null });
    await db.query("UPDATE live_activities SET sealed=$2 WHERE id=$1",[raw(cardId),notice("card",[`dev_${phoneId}`])]);
    expect(items(await now(mac)).find((entry) => entry.id === cardId)).not.toHaveProperty("sealed");
  });

  test("reads the question's detail and pending entry, and answers it",async () => {
    await askedWork();
    const [question] = await copies();
    const pending = await as(mac,"GET","/api/inbox/pending");
    expect(pending.status).toBe(200);
    expect(pending.body.items.map((entry: any) => entry.interaction.id)).toEqual([`int_${question!.id}`]);
    expect((await as(mac,"GET",`/api/inbox/ntf_${question!.notification_event_id}`)).status).toBe(200);
    const answered = await as(mac,"POST",`/api/notifications/ntf_${question!.notification_event_id}/interactions`,
      { kind: "approve",idempotencyKey: randomUUID(),expectedInteractionId: `int_${question!.id}` });
    expect(answered.status,JSON.stringify(answered.body)).toBe(201);
    expect((await db.query("SELECT state::text,device_id FROM interaction_requests r JOIN interactions i ON i.interaction_request_id=r.id WHERE r.id=$1 AND i.kind='approve'",
      [question!.id])).rows[0]).toEqual({ state: "approved",device_id: macId });
  });

  test("answers only the copy the asker waits on when the card asks several phones",async () => {
    ({ id: secondId } = await device("Second phone","iPhone19,2",["choice_questions"],"authorized"));
    await askedWork();
    const all = await copies();
    expect(all.length).toBe(2);
    const pending = (await as(mac,"GET","/api/inbox/pending")).body.items.map((entry: any) => entry.interaction.id);
    expect(pending).toHaveLength(1);
    const asked = all.find((copy) => `int_${copy.id}` === pending[0])!;
    const other = all.find((copy) => copy !== asked)!;
    const refused = await as(mac,"POST",`/api/notifications/ntf_${other.notification_event_id}/interactions`,{ kind: "approve",idempotencyKey: randomUUID() });
    expect(refused).toMatchObject({ status: 409,body: { error: "not_asked_copy" } });
    const answered = await as(mac,"POST",`/api/notifications/ntf_${asked.notification_event_id}/interactions`,{ kind: "approve",idempotencyKey: randomUUID() });
    expect(answered.status,JSON.stringify(answered.body)).toBe(201);
    expect(secondId).toBeTruthy();
  });

  test("lists its capabilities, approves no device and holds no phone back",async () => {
    const key = (fill: number) => Buffer.concat([Buffer.from([4]),Buffer.alloc(64,fill)]).toString("base64url");
    // The Mac came first; the iPhone registered after it.
    await db.query("UPDATE devices SET registered_at=now()-interval '1 day' WHERE id=$1",[macId]);
    for (const [id,fill] of [[macId,1],[phoneId,2]] as const) {
      await db.query("INSERT INTO device_identity_keys(device_id,principal_id,key_id,public_key) VALUES ($1,$2,$3,$4)",
        [id,principalId,`k_${String(fill).repeat(22)}`,key(fill)]);
    }
    expect((await pendingDevices(db,principalId)).map((entry) => entry.deviceId)).not.toContain(`dev_${phoneId}`);
    expect(await approveDevice(db,principalId,macId,{ deviceId: `dev_${phoneId}`,identityKey: key(2),signedAt: new Date().toISOString(),signature: b64(64) }))
      .toEqual({ ok: false,error: "device_not_found" });
    const listed = await listDeviceKeys(db,principalId);
    expect(listed.find((entry) => entry.deviceId === `dev_${macId}`)?.capabilities).toEqual(["choice_questions","owner_overview"]);
    expect(listed.find((entry) => entry.deviceId === `dev_${phoneId}`)?.capabilities).toEqual([]);
  });
});
