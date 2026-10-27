import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { loadInboxSnapshot } from "../inbox/queries.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Session works: lifecycle, plan, isolation",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>;
  const owner = "works_owner_abcdefghijklmnopqrstuvwxyz0123456789";
  const secret = "works-secret-with-at-least-32-characters-long";
  const A = "sessionAAAAAAAAAAAAAAAAAAAAAAAA";
  const B = "sessionBBBBBBBBBBBBBBBBBBBBBBBB";
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

  async function request(method: string,path: string,body?: unknown,session: string | null = A,key = randomUUID(),token = owner) {
    const response = await app.request(path,{
      method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json","idempotency-key": key,
        ...(session ? { "relo-session-key": session,"relo-harness": "claude-code" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  const start = (body: Record<string,unknown>,session = A) =>
    request("POST","/api/session/works",{ goal: { readable: "Ship works" },context,...body },session);

  test("start creates, a repeat start continues and ignores goal and plan",async () => {
    const first = await start({ plan: { op: "set",steps: [{ label: "Schema" },{ label: "Routes" },{ label: "Tests" }] } });
    expect(first.status).toBe(201);
    expect(first.body.disposition).toBe("started");
    expect(first.body.work.plan.steps.map((step: any) => [step.id,step.state])).toEqual([["s1","current"],["s2","open"],["s3","open"]]);
    const again = await start({ goal: { readable: "Other" },status: { readable: "Halfway" },plan: { op: "next" } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ disposition: "continuing",ignored: ["goal","plan"] });
    expect(again.body.work).toMatchObject({ id: first.body.work.id,goal: "Ship works",status: "Halfway" });
    expect(principalId).toBeTruthy();
  });

  test("plan commands keep stable ids; finish requires an outcome and skips open steps",async () => {
    const first = await start({ plan: { op: "set",steps: [{ label: "A" },{ label: "B" }] } });
    const id = first.body.work.id;
    const next = await request("PATCH",`/api/session/works/${id}`,{ plan: { op: "next" } });
    expect(next.body.work.plan.steps.map((step: any) => step.state)).toEqual(["done","current"]);
    const added = await request("PATCH","/api/session/works/current",{ plan: { op: "add",steps: [{ label: "C" }] },progress: { done: 1,total: 4 } });
    expect(added.body.work.plan.steps.map((step: any) => step.id)).toEqual(["s1","s2","s3"]);
    expect(added.body.work.plan.steps[1].progress).toEqual({ done: 1,total: 4 });
    expect((await request("POST",`/api/session/works/${id}/finish`,{ result: "finished" })).status).toBe(422);
    const done = await request("POST",`/api/session/works/${id}/finish`,{ result: "finished",outcome: { readable: "Shipped" } });
    expect(done.body.work).toMatchObject({ lifecycle: "finished",outcome: "Shipped" });
    expect(done.body.work.plan.steps.map((step: any) => step.state)).toEqual(["done","done","skipped"]);
    expect((await request("PATCH",`/api/session/works/${id}`,{ status: { readable: "x" } })).body.error).toBe("work_finished");
  });

  test("start --new parks; resume swaps; pause and waiting",async () => {
    const first = await start({});
    const second = await start({ goal: { readable: "Second" },new: true });
    expect(second.body.disposition).toBe("switched");
    expect(second.body.parked.map((work: any) => work.id)).toEqual([first.body.work.id]);
    const resumed = await request("POST",`/api/session/works/${first.body.work.id}/resume`,{});
    expect(resumed.body.work.lifecycle).toBe("open");
    expect(resumed.body.parked.map((work: any) => work.id)).toEqual([second.body.work.id]);
    const waiting = await request("PATCH","/api/session/works/current",{ waiting: { reason: { readable: "CI" } } });
    expect(waiting.body.work.waiting.reason).toBe("CI");
    const paused = await request("POST","/api/session/works/current/pause",{ status: { readable: "Lunch" } });
    expect(paused.body.work).toMatchObject({ lifecycle: "paused",pausedReason: "declared" });
    expect((await request("PATCH","/api/session/works/current",{ status: { readable: "x" } })).body.error).toBe("not_open");
  });

  test("another session's work answers not found and changes nothing",async () => {
    const mine = await start({});
    const foreign = await request("PATCH",`/api/session/works/${mine.body.work.id}`,{ status: { readable: "hijack" } },B);
    const missing = await request("PATCH",`/api/session/works/wrk_${randomUUID()}`,{ status: { readable: "hijack" } },B);
    expect(foreign).toEqual(missing);
    expect(foreign.status).toBe(404);
    expect((await request("GET","/api/session/works",undefined,B)).body).toEqual({ open: null,parked: [] });
    expect((await request("GET",`/api/session/works/${mine.body.work.id}`)).body.work.status).toBeNull();
    expect((await request("GET","/api/works")).status).toBe(403);
    expect((await request("GET","/api/works",undefined,null)).body.works).toHaveLength(1);
    expect((await request("POST","/api/session/works",{ goal: { readable: "x" } },null)).body.error).toBe("session_key_required");
  });

  test("admin finish: the owner ends a hanging work of any session; a session never can, a moving work is refused",async () => {
    const paused = await start({ status: { readable: "Halfway" } });
    await request("POST","/api/session/works/current/pause",{ status: { readable: "Parked for a test" } });
    const finish = (id: string,session: string | null = null) =>
      request("POST",`/api/works/${id}/finish`,{ result: "dropped",outcome: { readable: "Test card" } },session);
    expect((await finish(paused.body.work.id,B)).status).toBe(403);
    const listed = await request("GET","/api/works?state=live",undefined,null);
    expect(listed.body.works.map((work: any) => [work.id,work.lifecycle])).toEqual([[paused.body.work.id,"paused"]]);
    expect(listed.body.works[0].updatedAt).toEqual(expect.any(String));
    const ended = await finish(paused.body.work.id);
    expect(ended.status).toBe(200);
    expect(ended.body.work).toMatchObject({ lifecycle: "dropped",outcome: "Test card" });
    expect((await request("GET","/api/session/works")).body).toEqual({ open: null,parked: [] });
    expect((await finish(paused.body.work.id)).body.error).toBe("work_finished");

    const moving = await start({ goal: { readable: "Still building" },new: true },B);
    const refused = await finish(moving.body.work.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("work_running");
    expect((await request("GET","/api/session/works",undefined,B)).body.open.id).toBe(moving.body.work.id);
    // The hanging rule reads the derivation, which reads the declared clocks of the work and its card.
    await db.query("UPDATE works SET declared_at=now() - interval '21 minutes',updated_at=now() - interval '21 minutes' WHERE id=$1",[moving.body.work.id.slice(4)]);
    await db.query("UPDATE live_activities SET declared_at=now() - interval '21 minutes' WHERE work_id=$1",[moving.body.work.id.slice(4)]);
    expect((await finish(moving.body.work.id)).body.work.lifecycle).toBe("dropped");
  });

  test("cards are views of works: start, update, end",async () => {
    await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
      live_activity_push_to_start_token) VALUES ($1,$2,$3,'Phone','com.example.relo.notifications','1','1','26','sandbox',
      'authorized','authorized','fixture-alert','fixture-start')`,[principalId,randomUUID(),randomUUID()]);
    const first = await start({ plan: { op: "set",steps: [{ label: "A" },{ label: "B" }] } });
    expect(first.body.work.card?.state).toBe("active");
    const card = async () => (await db.query("SELECT * FROM live_activities WHERE work_id=$1",[first.body.work.id.slice(4)])).rows;
    expect((await card())[0]).toMatchObject({ title: "Ship works",producer_type: "agent_session",session_key: A });
    await request("PATCH","/api/session/works/current",{ status: { readable: "Now B" },plan: { op: "next" } });
    expect((await card())[0].status).toBe("Now B");
    await request("POST","/api/session/works/current/finish",{ result: "finished",outcome: { readable: "Done well" } });
    expect((await card())[0]).toMatchObject({ state: "ended",status: "Done well" });
  });

  test("a sealed work stores no readable text and refuses labels and readable writes",async () => {
    const sealed = await request("POST","/api/session/works",{ goal: { sealed: true },status: { sealed: true },context,
      plan: { op: "set",steps: [{ id: "s1" },{ id: "s2" }] } });
    expect(sealed.status).toBe(201);
    expect(sealed.body.work).toMatchObject({ sealed: true,goal: null,status: null });
    expect((await request("PATCH","/api/session/works/current",{ plan: { op: "add",steps: [{ id: "s9" }] } })).body.error).toBe("plan_ids_invalid");
    expect((await request("PATCH","/api/session/works/current",{ plan: { op: "add",steps: [{ label: "x" }] } })).body.error).toBe("labels_sealed");
    expect((await request("PATCH","/api/session/works/current",{ status: { readable: "x" } })).status).toBe(422);
    const row = (await db.query("SELECT goal,status,plan FROM works WHERE id=$1",[sealed.body.work.id.slice(4)])).rows[0];
    expect(row).toMatchObject({ goal: null,status: null });
    expect(JSON.stringify(row.plan)).not.toContain("label");
  });

  test("another account with the same session key answers not found",async () => {
    const other = "works_other_abcdefghijklmnopqrstuvwxyz0123456789";
    await bootstrapOwner(db,"other",other);
    const mine = await start({});
    const foreign = await request("GET",`/api/session/works/${mine.body.work.id}`,undefined,A,randomUUID(),other);
    expect(foreign).toEqual({ status: 404,body: { error: "not_found",message: "Work not found in this session." } });
    expect((await request("GET","/api/session/works",undefined,A,randomUUID(),other)).body).toEqual({ open: null,parked: [] });
    expect((await request("GET",`/api/works/${mine.body.work.id}`,undefined,null,randomUUID(),other)).status).toBe(404);
  });

  test("an idempotent retry replays",async () => {
    const key = randomUUID();
    const one = await request("POST","/api/session/works",{ goal: { readable: "Once" },context },A,key);
    const two = await request("POST","/api/session/works",{ goal: { readable: "Once" },context },A,key);
    expect(two.body).toMatchObject({ replayed: true,work: { id: one.body.work.id } });
  });

  test("producer_sealed is stored opaquely and returned only to its own session (2.21)",async () => {
    const copy = { v: "relo.work-self.v1",kid: "k1",nonce: "bm9uY2U",ciphertext: "Y2lwaGVy" };
    const sealed = await request("POST","/api/session/works",{ goal: { sealed: true },context,
      plan: { op: "set",steps: [{ id: "s1" },{ id: "s2" }] },producerSealed: copy });
    expect(sealed.body.work.producerSealed).toEqual(copy);
    const next = { ...copy,ciphertext: "bmV4dA" };
    await request("PATCH","/api/session/works/current",{ plan: { op: "next" },producerSealed: next });
    expect((await request("GET","/api/session/works")).body.open.producerSealed).toEqual(next);
    const paused = { ...copy,ciphertext: "cGF1c2Vk" };
    await request("POST","/api/session/works/current/pause",{ status: { sealed: true },producerSealed: paused });
    expect((await request("GET",`/api/session/works/${sealed.body.work.id}`)).body.work.producerSealed).toEqual(paused);
    // Other sessions never see it; the owner's API key gets it opaquely (only the sealing computer can open it).
    expect((await request("GET","/api/works",undefined,null)).body.works[0].producerSealed).toEqual(paused);
    expect((await request("GET",`/api/session/works/${sealed.body.work.id}`,undefined,B)).status).toBe(404);
  });

  test("a replay with fresh envelopes answers the first result; finish replaces the status",async () => {
    const started = await start({ status: { readable: "Building" },plan: { op: "set",steps: [{ label: "Build" },{ label: "Ship" }] } });
    const id = started.body.work.id;
    const key = randomUUID();
    const one = await request("PATCH",`/api/session/works/${id}`,{ plan: { op: "next" },producerSealed: { v: "a" } },A,key);
    const two = await request("PATCH",`/api/session/works/${id}`,{ plan: { op: "next" },producerSealed: { v: "b" } },A,key);
    expect(two.status).toBe(200);
    expect(two.body).toMatchObject({ replayed: true,work: { version: one.body.work.version } });
    expect(two.body.work.plan.steps.map((step: any) => step.state)).toEqual(["done","current"]);
    const done = await request("POST",`/api/session/works/${id}/finish`,{ result: "finished",outcome: { readable: "Shipped" } });
    expect(done.body.work).toMatchObject({ status: null,outcome: "Shipped" });
    expect(done.body.work.plan.steps.map((step: any) => step.state)).toEqual(["done","done"]);
  });

  // The card carries an 8-step window of a long plan; History carries the whole plan for the detail page.
  test("history items carry the work's whole plan",async () => {
    // A paired phone, so the card is delivered and History has its events.
    await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
      live_activity_push_to_start_token) VALUES ($1,$2,$3,'Phone','com.example.relo.notifications','1','1','26','sandbox',
      'authorized','authorized','fixture-alert','fixture-start')`,[principalId,randomUUID(),randomUUID()]);
    const labels = Array.from({ length: 10 },(_,index) => ({ label: `Phase ${index + 1}` }));
    const first = await start({ plan: { op: "set",steps: labels } });
    expect(first.status).toBe(201);
    const snapshot = await loadInboxSnapshot(db,{ principalId });
    // Each work's plan comes once, in the snapshot's works map.
    const items = snapshot.items.filter((item) => item.activity?.workId);
    expect(items.length).toBeGreaterThan(0);
    const plan = snapshot.works![items[0]!.activity!.workId!]!.plan!;
    expect(plan.map((step) => step.label)).toEqual(labels.map((step) => step.label));
    expect(plan[0]).toMatchObject({ id: "s1",state: "current" });
    expect(items[0]!.activity!.steps).toMatchObject({ done: 0,total: 10 });
  });
});
