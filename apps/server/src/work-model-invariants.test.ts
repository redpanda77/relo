import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { purgeUnreadableContent } from "./unreadable-content.js";
import { fixtureEnvelope,fixturePhone,fixtureSealedCard } from "./test-support/sealed-fixtures.js";

/**
 * ADR 0007 invariants on the card surface (/api/live-activities). Each test fails if a coupling the
 * ADR removed comes back: a second start rewriting a running card, sealed text drifting from the
 * presentation it describes, or a phone's key change ending work.
 */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("work model invariants on cards (ADR 0007, P0-A)",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>;
  const owner = "work_invariants_owner_abcdefghijklmnopqrstuvwxyz";
  const context = { providerName: "Claude Code",project: "relo",threadName: "Release" };

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: "work-invariants-secret-with-32-characters" });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function request(method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${owner}`,"content-type": "application/json",
      "idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  const card = async (id: string) => (await db.query("SELECT * FROM live_activities WHERE id=$1",[id.slice(4)])).rows[0];

  test("a second ensure start never changes title, topic, steps or sealed text; it answers existing",async () => {
    const phone = await fixturePhone(db,principalId);
    const firstSealed = fixtureSealedCard([phone.publicId]);
    const first = await request("POST","/api/live-activities",{ key: "session-claude-code-abc",acquireMode: "ensure",
      title: "Encrypted card",status: "Updating…",steps: { labels: ["Step 1","Step 2"],current: 1 },context,sealed: firstSealed });
    expect(first.status).toBe(201);
    const before = await card(first.body.activity.id);
    const events = (await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n;
    const second = await request("POST","/api/live-activities",{ key: "session-claude-code-abc",acquireMode: "ensure",
      title: "Encrypted card",status: "Updating…",steps: { labels: ["Step 1","Step 2","Step 3"],current: 3 },
      context: { ...context,threadName: "Another topic" },sealed: fixtureSealedCard([phone.publicId]) });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ disposition: "existing",reused: true,queued: 0,
      activity: { id: first.body.activity.id,sequence: 0 } });
    const after = await card(first.body.activity.id);
    for (const column of ["title","status","detail","presentation","context","sealed","sequence","updated_at"]) {
      expect(after[column],column).toEqual(before[column]);
    }
    expect(after.sealed).toEqual(firstSealed);
    // Nothing was pushed for it.
    expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(events);
  });

  test("a selector-free start never adopts a running card; it stores its own sealed text",async () => {
    const phone = await fixturePhone(db,principalId);
    const first = await request("POST","/api/live-activities",{ acquireMode: "ensure",title: "Encrypted card",
      status: "Updating…",context,sealed: fixtureSealedCard([phone.publicId]) });
    expect(first.status).toBe(201);
    const next = fixtureSealedCard([phone.publicId]);
    const reused = await request("POST","/api/live-activities",{ acquireMode: "ensure",title: "Encrypted card",
      status: "Updating…",progress: 0.5,context,sealed: next });
    // A selector-free start never adopts or changes a running card: it is its own card, and the first is untouched.
    expect(reused.body).toMatchObject({ disposition: "created",activity: { sequence: 0 } });
    expect(reused.body.activity.id).not.toBe(first.body.activity.id);
    expect((await card(reused.body.activity.id)).sealed).toEqual(next);
    expect((await card(first.body.activity.id)).state).toBe("active");
    const pushed = (await db.query(`SELECT count(*)::int AS n FROM notification_events
      WHERE payload#>>'{liveActivity,activityId}'=$1 AND payload#>>'{liveActivity,operation}'='update'`,[first.body.activity.id])).rows[0].n;
    expect(pushed).toBe(0);
  });

  test("an update held under a question stores its sealed text with it",async () => {
    const phone = await fixturePhone(db,principalId);
    const started = await request("POST","/api/live-activities",{ key: "held",acquireMode: "ensure",title: "Encrypted card",
      status: "Updating…",context,sealed: fixtureSealedCard([phone.publicId]) });
    const id = started.body.activity.id;
    const asked = await request("POST",`/api/live-activities/${id}/wait`,{ type: "yes_no",
      sealed: { alerts: [fixtureEnvelope([phone.publicId],"question","int:q")],content: fixtureEnvelope([phone.publicId],"question","int:q") } });
    expect(asked.status).toBe(201);
    const next = fixtureSealedCard([phone.publicId]);
    const updated = await request("PATCH",`/api/live-activities/${id}`,{ status: "Updating…",sealed: next });
    expect(updated.status).toBe(200);
    const row = await card(id);
    expect(row.resume_presentation).not.toBeNull();
    expect(row.sealed).toEqual(next);
  });

  test("a phone's key change never ends a card: it keeps running on placeholders until the next write re-seals it",async () => {
    const phone = await fixturePhone(db,principalId);
    const started = await request("POST","/api/live-activities",{ key: "rotate",acquireMode: "ensure",title: "Encrypted card",
      status: "Updating…",context,sealed: fixtureSealedCard([phone.publicId]) });
    const id = started.body.activity.id;
    const before = await card(id);
    await db.query("DELETE FROM device_prekeys WHERE device_id=$1",[phone.id]);
    expect(await purgeUnreadableContent(db,principalId,"sandbox")).toMatchObject({ cardsUnsealed: 1 });
    const after = await card(id);
    expect(after).toMatchObject({ state: "active",sequence: before.sequence,title: "Encrypted card",sealed: null });
    expect(after.terminal_reason).toBeNull();
    // The holder's next write seals it again for the new key.
    await db.query(`INSERT INTO device_prekeys(device_id,principal_id,prekey_id,public_key,signature,signed_created_at)
      VALUES ($1,$2,'pk_1',$3,$4,$5)`,[phone.id,principalId,"A".repeat(87),"B".repeat(86),new Date().toISOString()]);
    const resealed = fixtureSealedCard([phone.publicId]);
    expect((await request("PATCH",`/api/live-activities/${id}`,{ status: "Updating…",sealed: resealed })).status).toBe(200);
    expect((await card(id)).sealed).toEqual(resealed);
  });
});
