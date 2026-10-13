import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { endAllActiveActivities } from "./activity-commands/runtime.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Active cards are ended, never silently deleted",() => {
  let db: Database,principalId: string;
  const owner = "active_guard_owner_abcdefghijklmnopqrstuvwxyz";
  const secret = "active-guard-secret-with-at-least-32-characters";
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
      live_activity_push_to_start_token) VALUES ($1,$2,$3,'Phone','com.example.relo.notifications','1','1','26','sandbox',
      'authorized','authorized','fixture-alert','fixture-start')`,[principalId,randomUUID(),randomUUID()]);
  });
  async function startCard(key: string) {
    const response = await createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret }).request("/api/live-activities",{
      method: "POST",headers: { authorization: `Bearer ${owner}`,"content-type": "application/json","idempotency-key": randomUUID() },
      body: JSON.stringify({ key,acquireMode: "ensure",title: "Release",status: "Working",
        context: { providerName: "Claude Code",project: "relo",threadName: key } }) });
    expect(response.status).toBe(201);
    return (await response.json() as any).activity.id.slice(4) as string;
  }

  test("deleting an active card is refused until it has been ended",async () => {
    const id = await startCard("guarded");
    await expect(db.query("DELETE FROM live_activities WHERE id=$1",[id])).rejects.toThrow(/is active; end it/);
    expect(await endAllActiveActivities(db,"sandbox")).toBe(1);
    // Once ended, this guard no longer applies (other append-only evidence rules still may).
    await expect(db.query("DELETE FROM live_activities WHERE id=$1",[id])).rejects.not.toThrow(/is active; end it/);
  });

  test("ending all active cards sends each phone an end push with immediate dismissal",async () => {
    const first = await startCard("first");
    const second = await startCard("second");
    expect(await endAllActiveActivities(db,"sandbox")).toBe(2);
    const rows = (await db.query("SELECT id,state,terminal_reason FROM live_activities ORDER BY created_at")).rows;
    expect(rows.map((row) => [row.id,row.state,row.terminal_reason]))
      .toEqual([[first,"ended","operator_end"],[second,"ended","operator_end"]]);
    const ends = (await db.query(`SELECT payload#>>'{liveActivity,operation}' AS operation,
        (payload#>>'{liveActivity,dismissAfterSeconds}')::int AS dismiss
      FROM notification_events WHERE payload#>>'{liveActivity,operation}'='end'`)).rows;
    expect(ends).toHaveLength(2);
    expect(ends.every((row) => row.dismiss === 0)).toBe(true);
    const jobs = (await db.query(`SELECT count(*)::int AS n FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
      WHERE e.payload#>>'{liveActivity,operation}'='end'`)).rows[0].n;
    expect(jobs).toBe(2);
    expect(await endAllActiveActivities(db,"sandbox")).toBe(0);
  });

  test("an account deletion may remove its active cards because it revokes the phone",async () => {
    await startCard("account");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL relo.allow_active_activity_delete = 'on'");
      await client.query("DELETE FROM owner_principals WHERE id=$1",[principalId]);
      await client.query("COMMIT");
    } finally { client.release(); }
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(0);
  });
});
