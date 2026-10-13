import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createAccountAuth } from "../account-auth.js";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createAuthDatabase, createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { currentTestPresentation } from "../test-current-presentation.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Dashboard canonical decision admission", () => {
  let db: Database, authDb: Database, principalId: string, deviceId: string;
  let application: ReturnType<typeof createApp>, headers: Record<string, string>;
  const origin = "http://127.0.0.1:8180", secret = "dashboard-decision-secret-at-least-32-characters";
  const phone = "dashboard-decision-phone-abcdefghijklmnopqrstuvwxyz";
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); authDb = createAuthDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => { await Promise.all([db.end(), authDb.end()]); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    await db.query("TRUNCATE auth.sessions,auth.accounts,auth.verifications,auth.users CASCADE");
    await bootstrapOwner(db, "owner", "dashboard-owner-abcdefghijklmnopqrstuvwxyz");
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    deviceId = (await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,live_activity_push_to_start_token)
      VALUES ($1,$2,$3,'Fixture','com.example.relo.notifications','1','1','27','sandbox','authorized','authorized','fixture-alert','fixture-start') RETURNING id`,
      [principalId, randomUUID(), randomUUID()])).rows[0].id;
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['interactions:respond'])", [deviceId, hashToken(phone)]);
    application = createApp(db, { accountAuth: createAccountAuth(authDb, origin, secret), bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret, appUrl: origin, apnsMode: "sandbox" });
    const signup = await application.request("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name: "Fixture", email: "fixture@example.com", password: "unique-test-password" }) });
    expect(signup.status).toBe(200);
    const signin = await application.request("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "fixture@example.com", password: "unique-test-password", rememberMe: true }) });
    expect(signin.status).toBe(200);
    headers = { authorization: `Bearer ${signin.headers.get("set-auth-token")}`, "content-type": "application/json", origin };
  });
  async function post(path: string, body: unknown) {
    const response = await application.request(path, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  async function start(presentation = currentTestPresentation()) {
    const result = await post("/api/dashboard/live-activities/test", { deviceId: `dev_${deviceId}`, presentation });
    expect(result.status).toBe(201); return result.body;
  }
  async function stored(eventId: string) {
    return (await db.query(`SELECT r.id,r.expires_at,r.state,nr.relevance,e.expires_at AS event_deadline
      FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
      LEFT JOIN notification_relevance nr ON nr.notification_event_id=e.id WHERE e.id=$1`, [eventId.slice(4)])).rows[0];
  }
  test.each(["approval", "yes_no"])("%s folds into the running card with one deadline bounded by it", async kind => {
    const parent = await start();
    const deadline = (await db.query("UPDATE live_activities SET stale_at=NULL,expires_at=clock_timestamp()+interval '45 seconds' WHERE id=$1 RETURNING expires_at", [parent.activity.id.slice(4)])).rows[0].expires_at.toISOString();
    const result = await post(`/api/dashboard/live-activities/${parent.activity.id}/wait`, { kind, prompt: "Continue?" });
    expect(result.status).toBe(200);
    // No companion card: the question is on the card that is already running.
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(1);
    expect(result.body.activity.id).toBe(parent.activity.id);
    const card = (await db.query("SELECT status,presentation,resume_presentation FROM live_activities WHERE id=$1", [parent.activity.id.slice(4)])).rows[0];
    expect(card.status).toBe("Needs you");
    expect(card.presentation.behavior.type).toBe(kind);
    expect(card.resume_presentation).not.toBeNull();
    const row = await stored(result.body.eventId);
    expect(row.expires_at.toISOString()).toBe(deadline);
    expect(result.body.interaction.expiresAt).toBe(deadline);
    const answer = await application.request(`/api/notifications/${result.body.eventId}/interactions`, {
      method: "POST", headers: { authorization: `Bearer ${phone}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: kind === "approval" ? "approve" : "yes", value: {}, idempotencyKey: randomUUID(),
        expectedSubject: { ...row.relevance?.identity, revision: 2 } }),
    });
    expect(answer.status).toBe(409);
  });
  test("a Test Lab question waits at most five minutes and takes tappable answers only", async () => {
    const parent = await start();
    // A long-lived card, so the five-minute limit (not the card's own deadline) bounds the question.
    await db.query("UPDATE live_activities SET stale_at=NULL,expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [parent.activity.id.slice(4)]);
    const result = await post(`/api/dashboard/live-activities/${parent.activity.id}/wait`, { kind: "yes_no", prompt: "Continue?" });
    expect(result.status).toBe(200);
    // expiresAt comes from the database clock; allow for skew against this process's clock.
    const seconds = (Date.parse(result.body.interaction.expiresAt) - Date.now()) / 1000;
    expect(seconds).toBeLessThanOrEqual(301);
    expect(seconds).toBeGreaterThan(290);
    expect((await post(`/api/dashboard/live-activities/${parent.activity.id}/wait`, { kind: "text", prompt: "Why?" })).status).toBe(400);
  });
  test.each(["approval", "yes_no"])("Test Lab %s action expires with its native idle lease", async kind => {
    const presentation = { ...currentTestPresentation(), behavior: kind === "approval"
      ? { type: "approval", primary: { action: "approve", label: "Approve" }, secondary: { action: "deny", label: "Deny" } }
      : { type: "yes_no", primary: { action: "yes", label: "Yes" }, secondary: { action: "no", label: "No" } } } as ReturnType<typeof currentTestPresentation>;
    const first = await start(presentation);
    const row = await stored(first.eventId);
    expect(row.relevance?.deadlines.kind).toBe("decision");
    const native = (await db.query("SELECT expires_at FROM live_activities WHERE id=$1", [first.activity.id.slice(4)])).rows[0];
    expect(row.expires_at.toISOString()).toBe(native.expires_at.toISOString());
    expect(row.relevance?.deadlines.actionExpiresAt).toBe(native.expires_at.toISOString());
  });
  test.each(["approval", "yes_no"])("an elapsed active parent cannot admit a new %s wait", async kind => {
    const parent = await start();
    await db.query("UPDATE live_activities SET stale_at=NULL,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [parent.activity.id.slice(4)]);
    const result = await post(`/api/dashboard/live-activities/${parent.activity.id}/wait`, { kind, prompt: "Too late" });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("activity_not_active");
    expect((await db.query("SELECT count(*)::int AS n FROM interaction_requests")).rows[0].n).toBe(0);
  });

});
