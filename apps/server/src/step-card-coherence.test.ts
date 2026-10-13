import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { loadInboxSnapshot } from "./inbox/queries.js";

// A card shows one honest progress: its steps. A derived value never becomes a second bar,
// and the outcome of an end decides the steps.
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Step cards stay coherent from start to end",() => {
  let db: Database,principalId: string;
  const owner = "step_card_owner_abcdefghijklmnopqrstuvwxyz";
  const secret = "step-card-secret-with-at-least-32-characters";
  const labels = ["Build","Test","Ship"];
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
  async function call(method: string,path: string,body: unknown) {
    const response = await createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret }).request(path,{
      method,headers: { authorization: `Bearer ${owner}`,"content-type": "application/json","idempotency-key": randomUUID() },
      body: JSON.stringify(body) });
    const json = await response.json() as any;
    expect(response.status,JSON.stringify(json)).toBeLessThan(300);
    return json;
  }
  const start = (extra: Record<string,unknown> = {}) => call("POST","/api/live-activities",{
    key: `steps-${randomUUID()}`,acquireMode: "ensure",title: "Release",status: "Building",
    steps: { labels,current: 2 },context: { providerName: "Claude Code",project: "relo",threadName: "Release" },...extra,
  });
  async function card(id: string) {
    return (await db.query("SELECT progress,presentation FROM live_activities WHERE id=$1",[id.slice(4)])).rows[0];
  }
  const types = (presentation: any) => presentation.components.map((component: any) => component.type);
  const stepStates = (presentation: any) =>
    presentation.components.find((component: any) => component.type === "steps").items.map((item: any) => item.state);

  test("updating the steps never invents a frozen second progress bar",async () => {
    const started = await start();
    expect(types((await card(started.activity.id)).presentation)).toEqual(["steps"]);
    await call("PATCH",`/api/live-activities/${started.activity.id}`,{ status: "Testing",steps: { labels,current: 3 } });
    const updated = await card(started.activity.id);
    expect(types(updated.presentation)).toEqual(["steps"]);
    expect(stepStates(updated.presentation)).toEqual(["complete","complete","current"]);
    expect(Number(updated.progress)).toBeCloseTo(2/3);
  });

  test("a status-only update keeps the card's steps",async () => {
    const started = await start();
    await call("PATCH",`/api/live-activities/${started.activity.id}`,{ status: "Still building" });
    const updated = await card(started.activity.id);
    expect(types(updated.presentation)).toEqual(["steps"]);
    expect(stepStates(updated.presentation)).toEqual(["complete","current","pending"]);
    expect(updated.presentation.content.status).toBe("Still building");
  });

  test("an explicit measured progress is kept beside the steps and carried by later updates",async () => {
    const started = await start({ progress: 0.4 });
    await call("PATCH",`/api/live-activities/${started.activity.id}`,{ status: "Testing",steps: { labels,current: 3 } });
    const updated = await card(started.activity.id);
    expect(types(updated.presentation)).toEqual(["steps","progress_bar"]);
    expect(updated.presentation.components[1].value).toBeCloseTo(0.4);
  });

  test("a successful end completes the steps; a failed end keeps where the work stopped",async () => {
    const done = await start();
    await call("POST",`/api/live-activities/${done.activity.id}/end`,{ status: "Shipped" });
    const ended = (await card(done.activity.id)).presentation;
    expect(ended.state.kind).toBe("completed");
    expect(stepStates(ended)).toEqual(["complete","complete","complete"]);

    const failed = await start();
    await call("POST",`/api/live-activities/${failed.activity.id}/end`,{ status: "Tests failed",symbol: "warning" });
    const stopped = (await card(failed.activity.id)).presentation;
    expect(stopped.state.kind).toBe("failed");
    expect(stepStates(stopped)).toEqual(["complete","current","pending"]);
  });

  test("a successful end fills a measured bar",async () => {
    const started = await start({ progress: 0.4 });
    await call("POST",`/api/live-activities/${started.activity.id}/end`,{ status: "Shipped" });
    const ended = await card(started.activity.id);
    expect(ended.presentation.components.find((component: any) => component.type === "progress_bar").value).toBe(1);
    expect(Number(ended.progress)).toBe(1);
  });

  test("history rows say how the card behind them turned out",async () => {
    const started = await start();
    await call("PATCH",`/api/live-activities/${started.activity.id}`,{ status: "Testing",steps: { labels,current: 3 } });
    let rows = (await loadInboxSnapshot(db,{ principalId })).items.filter((item) => item.activityEvent?.id === started.activity.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.activity).toMatchObject({ state: "active",outcome: null,status: "Testing",
      steps: { done: 2,total: 3,current: "Ship" },endedAt: null });
    await call("POST",`/api/live-activities/${started.activity.id}/end`,{ status: "Shipped" });
    rows = (await loadInboxSnapshot(db,{ principalId })).items.filter((item) => item.activityEvent?.id === started.activity.id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.activity).toMatchObject({ state: "ended",outcome: "completed",status: "Shipped",
        steps: { done: 3,total: 3,current: null } });
      expect(row.activity!.updates).toBe(3);
      expect(row.activity!.endedAt).not.toBeNull();
    }
  });

  test("a stopped card names where it stopped, and a plain notification has no card",async () => {
    const failed = await start();
    await call("POST",`/api/live-activities/${failed.activity.id}/end`,{ status: "Tests failed",symbol: "warning" });
    const items = (await loadInboxSnapshot(db,{ principalId })).items;
    expect(items.find((item) => item.activityEvent?.id === failed.activity.id)!.activity)
      .toMatchObject({ outcome: "failed",status: "Tests failed",steps: { done: 1,total: 3,current: "Test" } });
    await db.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key)
      VALUES ($1,'Fixture','Plain','Body',gen_random_uuid()::text)`,[principalId]);
    expect((await loadInboxSnapshot(db,{ principalId })).items.find((item) => item.title === "Plain")!.activity).toBeNull();
  });
});
