import { randomBytes, randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { activityContentState,assertOrdinaryDeliveryIntentWithinBudget,deliveryProjection } from "./delivery-serialization.js";
import { migrate } from "./migrate.js";
import { checkSealedNotice,SEALED_PROMPT,SEALED_QUESTION_TITLE,SEALED_TITLE,sealedNoticeSchema,type SealedEnvelope } from "./sealed-content.js";

const b64 = (length: number) => randomBytes(length).toString("base64url");

/** Well-formed envelopes; the server checks shape only and never opens them. */
function envelope(devices: string[],{ kind = "notice",blocks = 1,sender = "k_AAAAAAAAAAAAAAAAAAAAAA",context = "acct:a/idem:1" } = {}): SealedEnvelope {
  return {
    v: "relo.e2e.v1",kind: kind as SealedEnvelope["kind"],context,sender,
    recipients: devices.map((device) => ({ device,prekey: "pk_1",enc: b64(65),key: b64(48) })),
    nonce: b64(12),ct: b64(256 * blocks + 16),sig: b64(64),
  };
}

describe("sealed notice shape",() => {
  const phone = `dev_${randomUUID()}`;
  const ipad = `dev_${randomUUID()}`;
  test("alerts name one phone each and the body covers every alerted phone",() => {
    expect(checkSealedNotice({ alerts: [envelope([phone]),envelope([ipad])],content: envelope([phone,ipad]) }))
      .toEqual({ ok: true,deviceIds: [phone,ipad] });
    for (const sealed of [
      { alerts: [envelope([phone,ipad])],content: envelope([phone,ipad]) },
      { alerts: [envelope([phone]),envelope([phone])],content: envelope([phone]) },
      { alerts: [envelope([phone])],content: envelope([ipad]) },
      { alerts: [envelope([phone],{ sender: "k_BBBBBBBBBBBBBBBBBBBBBB" })],content: envelope([phone]) },
      { alerts: [envelope([phone],{ context: "acct:a/idem:2" })],content: envelope([phone]) },
      { alerts: [envelope([phone],{ blocks: 6 })],content: envelope([phone]) },
      { alerts: [envelope(["dev_phone"])],content: envelope(["dev_phone"]) },
    ]) expect(checkSealedNotice(sealed).ok).toBe(false);
    expect(sealedNoticeSchema.safeParse({ alerts: [{ ...envelope([phone]),ct: b64(100) }],content: envelope([phone]) }).success).toBe(false);
    expect(sealedNoticeSchema.safeParse({ alerts: [{ ...envelope([phone]),extra: 1 }],content: envelope([phone]) }).success).toBe(false);
  });

  test("each phone's push carries only its own alert and no readable text",() => {
    const alerts = [envelope([phone]),envelope([ipad])];
    const payload = { privacy: "private",sealed: { alerts,content: envelope([phone,ipad]) } };
    const projection = deliveryProjection({
      transport: "notification",title: SEALED_TITLE,body: "Open Relo on your iPhone to read this.",notificationId: `ntf_${randomUUID()}`,
      payload,deviceId: ipad,accountId: `acc_${randomUUID()}`,serverOriginHash: "a".repeat(64),
    } as any) as any;
    expect(projection.alert).toEqual({ title: "Relo",body: "New private notification" });
    expect(projection.customData.relo.sealed).toEqual(alerts[1]);
    expect(projection.customData.relo.context).toBeUndefined();
    expect(JSON.stringify(projection.customData)).not.toContain(alerts[0]!.ct);
    expect(() => assertOrdinaryDeliveryIntentWithinBudget({
      title: SEALED_TITLE,body: "x",notificationId: "ntf_x",payload,
    })).not.toThrow();
  });
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("sealed notices through the API (E3.1)",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>;
  const owner = "sealed_notices_owner_abcdefghijklmnopqrstuvwxyz0";
  const secret = "sealed-notices-secret-with-at-least-32-characters";
  const context = { providerName: "Claude Code",project: "relo",threadName: "Release" };

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function request(method: string,path: string,body: unknown,token: string) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      "idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  async function phone() {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token) VALUES ($1,$2,$3,'Phone',
      'com.example.relo.notifications','1','1','26','sandbox','authorized','fixture-alert') RETURNING id`,
    [principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id,hashToken(credential)]);
    return { id,publicId: `dev_${id}`,credential };
  }
  async function cardPhone() {
    const created = await phone();
    await db.query(`UPDATE devices SET live_activity_authorization='authorized',live_activity_push_to_start_token='fixture-start'
      WHERE id=$1`,[created.id]);
    return created;
  }

  test("stores only envelopes and placeholders, and delivers only to the sealed phones",async () => {
    const sealedPhone = await phone();
    const otherPhone = await phone();
    const alerts = [envelope([sealedPhone.publicId])];
    const sealed = { alerts,content: envelope([sealedPhone.publicId]) };
    const created = await request("POST","/api/notifications",{ sourceName: "Claude Code",context,sealed },owner);
    expect(created.status).toBe(201);
    const eventId = created.body.eventId.slice(4);

    const row = (await db.query("SELECT title,body,payload,image_url,deep_link FROM notification_events WHERE id=$1",[eventId])).rows[0];
    expect(row.title).toBe(SEALED_TITLE);
    expect(row.payload.privacy).toBe("private");
    expect(row.payload.sealed).toEqual(sealed);
    const jobs = (await db.query("SELECT device_id FROM delivery_jobs WHERE notification_event_id=$1",[eventId])).rows;
    expect(jobs.map((job) => job.device_id)).toEqual([sealedPhone.id]);

    const detail = await request("GET",`/api/inbox/${created.body.eventId}`,undefined,sealedPhone.credential);
    expect(detail.status).toBe(200);
    const item = detail.body.item ?? detail.body;
    expect(item.title).toBe(SEALED_TITLE);
    expect(item.sealed).toEqual({ alert: alerts[0],content: sealed.content });
    const other = await request("GET",`/api/inbox/${created.body.eventId}`,undefined,otherPhone.credential);
    const otherItem = other.body?.item ?? other.body;
    if (other.status === 200) expect(otherItem.sealed?.alert ?? null).toBeNull();
  });

  test("refuses readable text, URLs, malformed envelopes and a device list that disagrees",async () => {
    const sealedPhone = await phone();
    const otherPhone = await phone();
    const sealed = { alerts: [envelope([sealedPhone.publicId])],content: envelope([sealedPhone.publicId]) };
    const post = (body: Record<string,unknown>) => request("POST","/api/notifications",{ sourceName: "Claude Code",context,...body },owner);
    expect((await post({ sealed,title: "Leaks" })).status).toBe(400);
    expect((await post({ sealed,destinationUrl: "https://example.com/secret" })).status).toBe(400);
    expect((await post({ sealed: { ...sealed,alerts: [envelope([sealedPhone.publicId,otherPhone.publicId])] } })).status).toBe(400);
    expect((await post({ sealed,deviceIds: [otherPhone.publicId] })).status).toBe(400);
    expect((await post({ sealed,deviceIds: [sealedPhone.publicId] })).status).toBe(201);
    const foreign = `dev_${randomUUID()}`;
    expect((await post({ sealed: { alerts: [envelope([foreign])],content: envelope([foreign]) } })).status).toBe(400);
  });

  test("a sealed in-app question stores only a placeholder prompt and the envelopes (E4.1)",async () => {
    const asked = await phone();
    const sealed = { alerts: [envelope([asked.publicId],{ kind: "question" })],content: envelope([asked.publicId],{ kind: "question" }) };
    const post = (body: Record<string,unknown>) => request("POST","/api/interactions",
      { type: "approval",context,answerInApp: true,...body },owner);
    const created = await post({ sealed });
    expect(created.status).toBe(201);
    const row = (await db.query(`SELECT e.title,e.payload,r.prompt FROM notification_events e
      JOIN interaction_requests r ON r.notification_event_id=e.id WHERE e.id=$1`,[created.body.eventId.slice(4)])).rows[0];
    expect(row).toMatchObject({ title: SEALED_QUESTION_TITLE,prompt: SEALED_PROMPT });
    expect(row.payload).toMatchObject({ privacy: "private",sealed });
    expect((await post({ sealed,prompt: "Deploy to production?" })).body).toEqual({ error: "sealed_with_plaintext" });
    // The explanation travels inside the seal too, never beside it.
    expect((await post({ sealed,detail: "Rewrites the orders table" })).body).toEqual({ error: "sealed_with_plaintext" });
    expect((await post({ sealed: { alerts: [envelope([asked.publicId])],content: envelope([asked.publicId]) } })).body)
      .toEqual({ error: "invalid_sealed_content" });
  });

  test("a sealed question folded into a card shows a placeholder and keeps the envelopes on its events",async () => {
    const asked = await cardPhone();
    const started = await request("POST","/api/live-activities",{ key: "sealed-question-card",title: "Release",status: "Working",
      context,deviceIds: [asked.publicId] },owner);
    expect(started).toMatchObject({ status: 201 });
    const sealed = { alerts: [envelope([asked.publicId],{ kind: "question" })],content: envelope([asked.publicId],{ kind: "question" }) };
    const waited = await request("POST",`/api/live-activities/${started.body.activity.id}/wait`,
      { type: "approval",expiresInSeconds: 120,sealed },owner);
    expect(waited).toMatchObject({ status: 201 });
    const card = (await db.query("SELECT presentation FROM live_activities WHERE id=$1",[started.body.activity.id.slice(4)])).rows[0];
    expect(JSON.stringify(card.presentation)).toContain(SEALED_PROMPT);
    const events = (await db.query(`SELECT e.payload,r.prompt FROM notification_events e
      JOIN interaction_requests r ON r.notification_event_id=e.id WHERE e.principal_id=$1`,[principalId])).rows;
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.prompt).toBe(SEALED_PROMPT);
      expect(event.payload.sealed).toEqual(sealed);
    }
    expect((await request("POST",`/api/live-activities/${started.body.activity.id}/wait`,
      { type: "approval",expiresInSeconds: 120,sealed,prompt: "Leak" },owner)).body).toEqual({ error: "sealed_with_plaintext" });
    expect((await request("POST",`/api/live-activities/${started.body.activity.id}/wait`,
      { type: "approval",expiresInSeconds: 120,sealed,detail: "Leak" },owner)).body).toEqual({ error: "sealed_with_plaintext" });
  });

  test("a sealed card carries each phone's envelope in its push and keeps it for later updates (E5)",async () => {
    const shown = await cardPhone();
    const alerts = [envelope([shown.publicId],{ kind: "card" })];
    const sealed = { alerts,content: envelope([shown.publicId],{ kind: "card" }) };
    const started = await request("POST","/api/live-activities",{ key: "sealed-card",title: "Encrypted card",status: "Updating…",
      context,deviceIds: [shown.publicId],sealed },owner);
    expect(started).toMatchObject({ status: 201 });
    const cardId = started.body.activity.id.slice(4);
    expect((await db.query("SELECT sealed FROM live_activities WHERE id=$1",[cardId])).rows[0].sealed).toEqual(sealed);
    const startEvent = (await db.query(`SELECT payload FROM notification_events WHERE payload#>>'{liveActivity,activityId}'=$1
      AND payload#>>'{liveActivity,operation}'='start'`,[started.body.activity.id])).rows[0];
    expect(startEvent.payload.liveActivity.sealed).toEqual(alerts[0]);
    const state = activityContentState({ ...startEvent.payload.liveActivity,generation: 1 },"standard",0);
    expect(state.sealed).toEqual(alerts[0]);

    // An update without new text (here only progress) still carries the stored envelope.
    const updated = await request("PATCH",`/api/live-activities/${started.body.activity.id}`,{ progress: 0.5 },owner);
    expect(updated).toMatchObject({ status: 200 });
    const latest = (await db.query(`SELECT payload FROM notification_events WHERE payload#>>'{liveActivity,activityId}'=$1
      ORDER BY created_at DESC LIMIT 1`,[started.body.activity.id])).rows[0];
    expect(latest.payload.liveActivity.sealed).toEqual(alerts[0]);

    // Live now reads the current feed: it carries this phone's envelope next to the placeholders.
    const current = await request("GET","/api/inbox/current?limit=50",undefined,shown.credential);
    expect(current.status).toBe(200);
    const live = current.body.items.find((item: any) => item.activity?.id === started.body.activity.id);
    expect(live.title).toBe("Encrypted card");
    expect(live.sealed).toEqual({ alert: alerts[0],content: sealed.content });

    // History and the Now caches repair from the snapshot: it carries this phone's envelope too.
    const snapshot = await request("GET","/api/inbox/snapshot",undefined,shown.credential);
    expect(snapshot.status).toBe(200);
    const cardEvents = snapshot.body.items.filter((item: any) => item.activityEvent?.id === started.body.activity.id);
    expect(cardEvents.length).toBeGreaterThan(0);
    for (const item of cardEvents) expect(item.sealed).toEqual({ alert: alerts[0],content: sealed.content });

    // The detail page of a card event opens the card's own envelope too (it was placeholders only).
    const detail = await request("GET",`/api/inbox/${cardEvents[0].id}`,undefined,shown.credential);
    expect(detail.status).toBe(200);
    expect((detail.body.item ?? detail.body).sealed).toEqual({ alert: alerts[0],content: sealed.content });

    const wrongKind = { alerts: [envelope([shown.publicId])],content: envelope([shown.publicId]) };
    expect((await request("POST","/api/live-activities",{ key: "bad-card",title: "Encrypted card",status: "Updating…",
      context,deviceIds: [shown.publicId],sealed: wrongKind },owner)).body).toEqual({ error: "invalid_sealed_content" });
  });
});
