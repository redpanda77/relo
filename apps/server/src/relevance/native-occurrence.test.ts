import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.js";
import { createActivityCommands } from "../activities.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Native activity occurrence and delivery fences", () => {
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
  const before = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
  test("late progress retains original occurrence and creates no newly eligible APNs job", async () => {
    const occurredAt = before(120), key = randomUUID();
    const input = { title: "Delayed run", status: "Working", occurredAt, expiresInSeconds: 3600 };
    const started = await request("/api/live-activities", input, owner, "POST", key);
    expect(started.status).toBe(201);
    expect(started.body.queued).toBe(0);
    expect((await db.query("SELECT payload FROM notification_events")).rows[0].payload.liveActivity.alertOwner).toBe("none");
    const current = await application.request("/api/inbox/current", { headers: { authorization: `Bearer ${phone}` } });
    const projection = await current.json() as any;
    expect(projection.items.find((item: any) => item.subjectId === started.body.activity.id)).toMatchObject({
      occurredAt, deliverUntil: new Date(Date.parse(occurredAt) + 15_000).toISOString(),
    });
    const replay = await request("/api/live-activities", input, owner, "POST", key);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.activity.expiresAt).toBe(started.body.activity.expiresAt);
  });
  test("exact sequence and original occurrence reject reordered producer updates", async () => {
    const started = await request("/api/live-activities", { title: "Run", status: "Start", occurredAt: before(120) });
    expect(started.status).toBe(201);
    const id = started.body.activity.id, sequence = started.body.activity.sequence;
    const update = { status: "Later milestone", occurredAt: before(60), ifSequence: sequence };
    const accepted = await request(`/api/live-activities/${id}`, update, owner, "PATCH");
    expect(accepted.status).toBe(200); expect(accepted.body.queued).toBe(0);
    const stale = await request(`/api/live-activities/${id}`, { status: "Old milestone", occurredAt: before(90),
      ifSequence: accepted.body.activity.sequence }, owner, "PATCH");
    expect(stale.status).toBe(409); expect(stale.body.error).toBe("stale_occurrence");
    const missingVersion = await request(`/api/live-activities/${id}`, { status: "Unversioned", occurredAt: before(30) }, owner, "PATCH");
    expect(missingVersion.status).toBe(400);
    const races = await Promise.all(["A", "B"].map(status => request(`/api/live-activities/${id}`, {
      status, occurredAt: before(20), ifSequence: accepted.body.activity.sequence,
    }, owner, "PATCH")));
    expect(races.map(result => result.status).sort()).toEqual([200, 409]);
  });
  test("terminal cleanup has its own bounded window and cannot renew on replay", async () => {
    const started = await request("/api/live-activities", { title: "Run", status: "Start", occurredAt: before(180) });
    expect(started.status).toBe(201);
    const key = randomUUID(), input = { occurredAt: before(120), ifSequence: started.body.activity.sequence };
    const ended = await request(`/api/live-activities/${started.body.activity.id}/end`, input, owner, "POST", key);
    expect(ended.status).toBe(200);
    const record = (await db.query("SELECT * FROM activity_mutation_freshness WHERE operation='end'")).rows[0];
    expect(record.occurred_at.toISOString()).toBe(input.occurredAt);
    expect(record.deliver_until.getTime() - record.accepted_at.getTime()).toBe(3_600_000);
    const replay = await request(`/api/live-activities/${started.body.activity.id}/end`, input, owner, "POST", key);
    expect(replay.body.replayed).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM activity_mutation_freshness WHERE operation='end'")).rows[0].n).toBe(1);
  });
  test("history pruning and command reconstruction preserve the first delivery deadline", async () => {
    const started = await request("/api/live-activities", { title: "Run", status: "Start", occurredAt: before(90) });
    expect(started.status).toBe(201);
    const original = (await db.query("SELECT * FROM activity_mutation_freshness")).rows[0];
    await db.query("DELETE FROM notification_events");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const activity = (await client.query("SELECT * FROM live_activities FOR UPDATE")).rows[0];
      const rebuilt = await createActivityCommands(client, { principalId: activity.principal_id, sourceName: "Fixture",
        activity, operation: "start", apnsMode: "sandbox" });
      expect(rebuilt.apnsJobs).toBe(0);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const retained = (await db.query("SELECT * FROM activity_mutation_freshness")).rows;
    expect(retained).toHaveLength(1); expect(retained[0]).toEqual(original);
  });
  test("a heartbeat cannot renew an existing progress frame's delivery window", async () => {
    const occurredAt = before(60);
    const lifecycle = { provider: "codex", runId: randomUUID() };
    const started = await request("/api/live-activities", { title: "Run", status: "Start", occurredAt, lifecycle,
      origin: { sourceInstance: "fixture", project: "fixture", thread: "fixture", channel: "progress" } });
    expect(started.status).toBe(201);
    const heartbeat = await request(`/api/live-activities/${started.body.activity.id}/heartbeat`, { lifecycle });
    expect(heartbeat.status).toBe(200);
    const response = await application.request("/api/inbox/current", { headers: { authorization: `Bearer ${phone}` } });
    const projection = await response.json() as any;
    expect(projection.items.find((item: any) => item.subjectId === started.body.activity.id)).toMatchObject({
      occurredAt, deliverUntil: new Date(Date.parse(occurredAt)+15_000).toISOString(),
    });
  });
  test("an unseen older run cannot replace the latest origin generation", async () => {
    const origin = { sourceInstance: "fixture", project: "fixture", thread: "shared", channel: "progress" };
    const newer = await request("/api/live-activities", { title: "Newer", status: "Working", origin,
      lifecycle: { provider: "codex", runId: "new-run" }, occurredAt: before(30) });
    expect(newer.status).toBe(201);
    const delayed = await request("/api/live-activities", { title: "Older", status: "Working", origin,
      lifecycle: { provider: "codex", runId: "old-run" }, occurredAt: before(120), replace: true });
    expect(delayed.status).toBe(409); expect(delayed.body.error).toBe("stale_occurrence");
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(1);
  });
  test("pre-cutover native records use their original server mutation time when reconstructed", async () => {
    const started = await request("/api/live-activities", { title: "Legacy", status: "Working" });
    expect(started.status).toBe(201);
    await db.query("DELETE FROM notification_events");
    await db.query("DELETE FROM activity_mutation_freshness");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const activity = (await client.query("UPDATE live_activities SET updated_at=now()-interval '120 seconds' RETURNING *")).rows[0];
      const result = await createActivityCommands(client, { principalId: activity.principal_id, sourceName: "Fixture",
        activity, operation: "start", apnsMode: "sandbox" });
      expect(result.apnsJobs).toBe(0);
      const record = (await client.query("SELECT * FROM activity_mutation_freshness")).rows[0];
      expect(record.occurred_at).toBeNull(); expect(record.accepted_at).toEqual(activity.updated_at);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  });
  test("restricted runtime can create and read chronology but cannot rewrite or delete it", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE relo_runtime");
      const privileges = (await client.query(`SELECT has_table_privilege(current_user,'activity_mutation_freshness','SELECT') AS read,
        has_table_privilege(current_user,'activity_mutation_freshness','INSERT') AS append,
        has_table_privilege(current_user,'activity_mutation_freshness','UPDATE') AS rewrite,
        has_table_privilege(current_user,'activity_mutation_freshness','DELETE') AS erase`)).rows[0];
      expect(privileges).toEqual({ read: true, append: true, rewrite: false, erase: false });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  test("future chronology rolls back the entire mutation and outbox", async () => {
    const result = await request("/api/live-activities", { title: "Future", status: "Working", occurredAt: new Date(Date.now()+60_000).toISOString() });
    expect(result.status).toBe(400); expect(result.body.error).toBe("invalid_occurrence");
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM delivery_jobs")).rows[0].n).toBe(0);
  });
});
