import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { expireDueActivities } from "./activities.js";
import { expireDueInteractiveActivities } from "./interactive-activity-lifecycle.js";
import { notifyUnseenQuestionCards } from "./activity-commands/question-fallback.js";
import { registerActivityUpdateToken } from "./activity-token-registration.js";
import { createNotificationContentCipher } from "./notification-content.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Card lifecycle: fallback, idle cleanup and the per-phone cap",() => {
  let db: Database,principalId: string;
  const owner = "card_lifecycle_owner_abcdefghijklmnopqrstuvwxyz";
  const secret = "card-lifecycle-secret-with-at-least-32-characters";
  const context = { providerName: "Claude Code",project: "relo",threadName: "Release" };
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });
  async function phone(liveActivities: boolean) {
    return (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
      live_activity_push_to_start_token) VALUES ($1,$2,$3,'Phone','com.example.relo.notifications','1','1','26','sandbox',
      'authorized',$4,'fixture-alert',$5) RETURNING id`,
    [principalId,randomUUID(),randomUUID(),liveActivities ? "authorized" : "denied",liveActivities ? "fixture-start" : null])).rows[0]!.id;
  }
  async function post(path: string,body: unknown) {
    const response = await createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret }).request(path,{
      method: "POST",headers: { authorization: `Bearer ${owner}`,"content-type": "application/json","idempotency-key": randomUUID() },
      body: JSON.stringify(body) });
    return { status: response.status,body: await response.json() as any };
  }
  const start = (key: string) => post("/api/live-activities",{ key,acquireMode: "ensure",title: "Release",status: "Working",context });
  const fallbacks = async () => (await db.query(
    "SELECT count(*)::int AS n FROM notification_events WHERE payload ? 'questionFallback'")).rows[0].n;

  test("a card question whose phone has no push-to-start route is announced once by a plain notification",async () => {
    const device = await phone(true);
    const card = await start("work-fallback");
    expect(card.status).toBe(201);
    await db.query("UPDATE devices SET live_activity_push_to_start_token=NULL,apns_environment='production' WHERE id=$1",[device]);
    const asked = await post(`/api/live-activities/${card.body.activity.id}/wait`,{ type: "approval",prompt: "Ship it?" });
    expect(asked.status).toBe(201);
    expect(asked.body.delivery.apnsJobs).toBe(0);
    expect(await fallbacks()).toBe(1);
    expect((await db.query("SELECT kind FROM notification_events WHERE payload ? 'questionFallback'")).rows[0].kind).toBe("notification");
    expect(await notifyUnseenQuestionCards(db,{ apnsMode: "sandbox",contentCipher: createNotificationContentCipher(secret) })).toBe(0);
    expect(await fallbacks()).toBe(1);
    // Unanswered: the question expires, the card ends, and the fallback notification is withdrawn.
    await db.query("UPDATE interaction_requests SET expires_at=clock_timestamp()-interval '1 second'");
    expect(await expireDueInteractiveActivities(db,"sandbox")).toBeGreaterThan(0);
    expect((await db.query("SELECT state,status FROM live_activities")).rows).toEqual([{ state: "expired",status: "No answer" }]);
    expect((await db.query("SELECT withdrawn_at IS NOT NULL AS withdrawn FROM notification_events WHERE payload ? 'questionFallback'")).rows)
      .toEqual([{ withdrawn: true }]);
  });

  test("with Live Activities off, a question is answered in Relo from a notification without buttons",async () => {
    await phone(false);
    const asked = await post("/api/interactions",{ title: "Release",prompt: "Ship it?",type: "approval",context,answerInApp: true });
    expect(asked.status).toBe(201);
    const event = (await db.query("SELECT payload FROM notification_events WHERE id=$1",[asked.body.eventId.slice(4)])).rows[0];
    expect(event.payload.answerInApp).toBe(true);
  });

  test("a card that never appeared on the phone triggers the fallback after the grace period",async () => {
    await phone(true);
    const card = await start("work-unseen");
    await post(`/api/live-activities/${card.body.activity.id}/wait`,{ type: "yes_no",prompt: "Continue?" });
    expect(await fallbacks()).toBe(0);
    await db.query("UPDATE live_activities SET updated_at=updated_at-interval '2 minutes'");
    expect(await notifyUnseenQuestionCards(db,{ apnsMode: "sandbox",contentCipher: createNotificationContentCipher(secret) })).toBe(1);
    expect(await fallbacks()).toBe(1);
  });

  test("a card that stopped updating only dims (ADR 0007); it ends at its hard expiry, never for silence",async () => {
    await phone(true);
    const idle = await start("work-idle");
    const asking = await start("work-asking");
    await post(`/api/live-activities/${asking.body.activity.id}/wait`,{ type: "yes_no",prompt: "Continue?" });
    await db.query("UPDATE live_activities SET stale_at=clock_timestamp()-interval '3 hours'");
    expect(await expireDueActivities(db,"disabled")).toBe(0);
    const states = async () => Object.fromEntries((await db.query("SELECT activity_key,state FROM live_activities")).rows
      .map((row: any) => [row.activity_key,row.state]));
    expect(await states()).toEqual({ "work-idle": "active","work-asking": "active" });
    await db.query("UPDATE live_activities SET expires_at=clock_timestamp()-interval '1 second' WHERE activity_key='work-idle'");
    expect(await expireDueActivities(db,"disabled")).toBe(1);
    expect(await states()).toEqual({ "work-idle": "expired","work-asking": "active" });
    expect(idle.status).toBe(201);
  });

  test("a sixth card on a phone ends the least recently updated idle card",async () => {
    await phone(true);
    for (let index = 0; index < 5; index += 1) {
      expect((await start(`work-${index}`)).status).toBe(201);
      await db.query("UPDATE live_activities SET updated_at=updated_at-($1*interval '1 minute') WHERE activity_key=$2",[10-index,`work-${index}`]);
    }
    expect((await start("work-5")).status).toBe(201);
    const active = (await db.query("SELECT activity_key FROM live_activities WHERE state='active' ORDER BY activity_key")).rows
      .map((row: any) => row.activity_key);
    expect(active).toEqual(["work-1","work-2","work-3","work-4","work-5"]);
  });
  test("the phone's proof that it showed a card outlives the card",async () => {
    const device = await phone(true);
    const card = await start("work-shown");
    const activityId = card.body.activity.id.slice(4);
    expect((await registerActivityUpdateToken(db,{ principalId,deviceId: device,activityId,generation: 1,
      nativeActivityId: "native-1",encryptedToken: "fixture-token",environment: "sandbox" })).kind).toBe("registered");
    expect((await post(`/api/live-activities/${card.body.activity.id}/end`,{ status: "Done" })).status).toBe(200);
    // The worker deletes the token once the end push is delivered.
    await db.query("DELETE FROM live_activity_update_tokens");
    expect((await db.query("SELECT device_id FROM live_activity_phone_evidence WHERE live_activity_id=$1",[activityId])).rows)
      .toEqual([{ device_id: device }]);
  });

  test("Claude Code and Codex sharing one login are separate sources",async () => {
    await phone(true);
    await post("/api/live-activities",{ key: "work-a",acquireMode: "ensure",title: "A",status: "Working",context });
    await post("/api/live-activities",{ key: "work-b",acquireMode: "ensure",title: "B",status: "Working",
      context: { ...context,providerName: "Codex" } });
    expect((await db.query("SELECT display_name FROM resource_sources ORDER BY display_name")).rows)
      .toEqual([{ display_name: "Claude Code" },{ display_name: "Codex" }]);
  });
});
