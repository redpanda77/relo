import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.js";
import { createActivityCommands } from "../activities.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { persistedPresentationColumns } from "../presentation-runtime.js";
import { currentTestPresentation } from "../test-current-presentation.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Generic native decision admission", () => {
  let db: Database, application: ReturnType<typeof createApp>;
  const owner = "native-decision-owner-abcdefghijklmnopqrstuvwxyz";
  const phone = "native-decision-phone-abcdefghijklmnopqrstuvwxyz";
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE"); await bootstrapOwner(db, "owner", owner);
    const principal = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    const device = (await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,live_activity_push_to_start_token)
      VALUES ($1,$2,$3,'Fixture','com.example.relo.notifications','1','1','27','sandbox','authorized','authorized','fixture-start') RETURNING id`,
      [principal, randomUUID(), randomUUID()])).rows[0].id;
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['interactions:respond','inbox:read'])", [device, hashToken(phone)]);
    application = createApp(db, { apnsMode: "sandbox", credentialDerivationSecret: "native-decision-secret-at-least-32-characters" });
  });
  async function request(path: string, body: unknown, token = owner, method = "POST", key = randomUUID()) {
    const result = await application.request(path, { method, headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key,
    }, body: JSON.stringify(body) });
    return { status: result.status, body: await result.json() as any };
  }
  function presentation(kind: "approval" | "yes_no" = "yes_no") {
    return { ...currentTestPresentation(), behavior: kind === "approval"
      ? { type: "approval", primary: { action: "approve", label: "Approve" }, secondary: { action: "deny", label: "Deny" } }
      : { type: "yes_no", primary: { action: "yes", label: "Yes" }, secondary: { action: "no", label: "No" } } };
  }
  async function decision(activityId: string) {
    return (await db.query(`SELECT e.id,e.state AS event_state,e.payload,e.expires_at AS event_deadline,
      r.id AS request_id,r.expires_at,r.state,nr.relevance FROM notification_events e
      JOIN interaction_requests r ON r.notification_event_id=e.id
      LEFT JOIN notification_relevance nr ON nr.notification_event_id=e.id
      WHERE e.payload#>>'{liveActivity,activityId}'=$1 ORDER BY e.created_at DESC,e.id`, [activityId])).rows[0];
  }
  test.each(["approval", "yes_no"] as const)("%s retains its native deadline and requires its exact version", async kind => {
    const started = await request("/api/live-activities", { presentation: presentation(kind), expiresInSeconds: 60 });
    expect(started.status).toBe(201);
    const row = await decision(started.body.activity.id);
    expect(row.relevance?.deadlines.kind).toBe("decision");
    expect(row.relevance.deadlines.actionExpiresAt).toBe(started.body.activity.expiresAt);
    expect(row.expires_at.toISOString()).toBe(started.body.activity.expiresAt);
    expect(row.event_deadline.toISOString()).toBe(started.body.activity.expiresAt);
    const action = { kind: kind === "approval" ? "approve" : "yes", idempotencyKey: randomUUID(),
      expectedSubject: { ...row.relevance.identity, revision: 2 } };
    expect((await request(`/api/notifications/ntf_${row.id}/interactions`, action, phone)).status).toBe(409);
    action.expectedSubject = row.relevance.identity;
    expect((await request(`/api/notifications/ntf_${row.id}/interactions`, action, phone)).status).toBe(201);
    expect((await decision(started.body.activity.id)).relevance.status).toBe("settled");
  });
  test("changing a question retires its original exact decision without settling the replacement", async () => {
    const started = await request("/api/live-activities", { presentation: presentation() });
    const first = await decision(started.body.activity.id);
    const updated = await request(`/api/live-activities/${started.body.activity.id}`, {
      presentation: { ...presentation(), content: { ...presentation().content, status: "New question" } },
    }, owner, "PATCH");
    expect(updated.status).toBe(200);
    const rows = (await db.query(`SELECT r.state,nr.relevance FROM interaction_requests r
      JOIN notification_relevance nr ON nr.notification_event_id=r.notification_event_id ORDER BY r.created_at`)).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: "canceled", relevance: { status: "settled" } });
    expect(rows[1]).toMatchObject({ state: "pending", relevance: { status: "active" } });
    expect(rows[0].relevance.identity.subjectKey).not.toBe(rows[1].relevance.identity.subjectKey);
    expect((await request(`/api/notifications/ntf_${first.id}/interactions`, {
      kind: "yes", idempotencyKey: randomUUID(), expectedSubject: first.relevance?.identity,
    }, phone)).status).toBe(409);
  });
  test("late command creation persists expiry and creates no active presentation or provider job", async () => {
    const started = await request("/api/live-activities", { presentation: currentTestPresentation() });
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query(`UPDATE live_activities SET expires_at=clock_timestamp()-interval '1 second',
        stale_at=NULL,sequence=sequence+1 WHERE id=$1 RETURNING *`, [started.body.activity.id.slice(4)])).rows[0];
      // The command producer can wait after reading its parent; admission must
      // use the database clock even if the transaction began while it was live.
      const stored = persistedPresentationColumns(presentation());
      row.presentation = stored.presentation; row.presentation_sha256 = stored.presentationHash;
      const result = await createActivityCommands(client, { principalId: row.principal_id, sourceName: "Fixture",
        activity: row, operation: "update", apnsMode: "sandbox" });
      expect(result).toMatchObject({ durableCommands: 0, apnsJobs: 0 });
      const native = (await client.query("SELECT state,presentation FROM live_activities WHERE id=$1", [row.id])).rows[0];
      expect(native.state).toBe("expired"); expect(native.presentation.behavior.type).toBe("informational");
      expect((await client.query("SELECT state FROM delivery_jobs WHERE live_activity_id=$1", [row.id])).rows)
        .toEqual([{ state: "canceled" }]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const expired = await decision(started.body.activity.id);
    expect(expired).toMatchObject({ state: "expired", event_state: "expired" });
    expect(expired.payload.liveActivity.operation).toBe("end");
    expect(expired.relevance.deadlines.actionExpiresAt).toBe(expired.expires_at.toISOString());
  });
  test("replay and pruned history keep the original deadline without admitting another decision", async () => {
    const key = randomUUID(), input = { presentation: presentation() };
    const started = await request("/api/live-activities", input, owner, "POST", key);
    const first = await decision(started.body.activity.id);
    const replay = await request("/api/live-activities", input, owner, "POST", key);
    expect(replay.body.activity.expiresAt).toBe(started.body.activity.expiresAt);
    expect((await decision(started.body.activity.id)).relevance).toEqual(first.relevance);
    await db.query("DELETE FROM notification_events WHERE id=$1", [first.id]);
    const pruned = await request("/api/live-activities", input, owner, "POST", key);
    expect(pruned.body.replayed).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM interaction_requests")).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM relevance_subjects")).rows[0].n).toBe(1);
  });
});
