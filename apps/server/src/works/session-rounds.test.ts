import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { loadOwnerStateInputs } from "../derive/load.js";
import { deriveOwnerState } from "../derive/owner-state.js";
import { loadInboxSnapshot } from "../inbox/queries.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Session works: deliver, rounds, nested plans",() => {
  let db: Database,app: ReturnType<typeof createApp>;
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
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
      live_activity_push_to_start_token) VALUES ($1,$2,$3,'Phone','com.example.relo.notifications','1','1','26','sandbox',
      'authorized','authorized','fixture-alert','fixture-start')`,[principalId,randomUUID(),randomUUID()]);
  });

  async function request(method: string,path: string,body?: unknown,session: string | null = A,key = randomUUID()) {
    const response = await app.request(path,{
      method,headers: { authorization: `Bearer ${owner}`,"content-type": "application/json","idempotency-key": key,
        ...(session ? { "relo-session-key": session,"relo-harness": "claude-code" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  const start = (body: Record<string,unknown>,session = A) =>
    request("POST","/api/session/works",{ goal: { readable: "Ship rounds" },context,...body },session);
  // dropRest by default: most tests here are about rounds, not about the open-steps refusal.
  const deliver = (outcome = "Round one shipped",id = "current",session = A,dropRest = true) =>
    request("POST",`/api/session/works/${id}/deliver`,{ outcome: { readable: outcome },...(dropRest ? { dropRest: true } : {}) },session);
  const cards = async (workId: string) =>
    (await db.query("SELECT state,status FROM live_activities WHERE work_id=$1 ORDER BY created_at",[workId.slice(4)])).rows;

  test("deliver closes the round, ends the card with the outcome, keeps the work open",async () => {
    const first = await start({ plan: { op: "set",steps: [{ label: "A" },{ label: "B" }] } });
    const id = first.body.work.id;
    await request("PATCH","/api/session/works/current",{ status: { readable: "Working" },waiting: { reason: { readable: "CI" } } });
    const done = await deliver();
    expect(done.status).toBe(200);
    expect(done.body.disposition).toBe("delivered");
    expect(done.body.work).toMatchObject({ lifecycle: "open",status: null,waiting: null,outcome: null });
    expect(done.body.work.plan.rounds).toEqual([expect.objectContaining({ n: 1,state: "closed",outcome: "Round one shipped" })]);
    expect(done.body.work.plan.steps.map((step: any) => step.state)).toEqual(["done","skipped"]);
    expect(await cards(id)).toEqual([{ state: "ended",status: "Round one shipped" }]);
    // Twice: no open round; the read still shows the work open.
    const again = await deliver();
    expect(again).toMatchObject({ status: 409,body: { error: "no_open_round" } });
    expect((await request("GET","/api/session/works/current")).body.work.id).toBe(id);
  });

  test("deliver refusals: outcome required, paused, foreign session",async () => {
    const mine = await start({});
    expect((await request("POST","/api/session/works/current/deliver",{})).body.error).toBe("outcome_required");
    const foreign = await deliver("x",mine.body.work.id,B);
    expect(foreign).toEqual(await deliver("x",`wrk_${randomUUID()}`,B));
    expect(foreign.status).toBe(404);
    expect((await request("GET",`/api/session/works/${mine.body.work.id}`)).body.work.plan.rounds).toBeUndefined();
    await request("POST","/api/session/works/current/pause",{ status: { readable: "Break" } });
    expect((await deliver("x",mine.body.work.id)).body.error).toBe("not_open");
  });

  test("a replayed deliver answers the first result",async () => {
    await start({});
    const key = randomUUID();
    const first = await request("POST","/api/session/works/current/deliver",{ outcome: { readable: "Once" } },A,key);
    const replay = await request("POST","/api/session/works/current/deliver",{ outcome: { readable: "Once" } },A,key);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ disposition: "delivered",replayed: true });
    expect(replay.body.work.version).toBe(first.body.work.version);
  });

  test("start on a delivered work needs --round; with it round 2 opens with steps and a new card",async () => {
    const first = await start({ plan: { op: "set",steps: [{ label: "A" }] } });
    const id = first.body.work.id;
    await deliver();
    const refused = await start({ plan: { op: "set",steps: [{ label: "Ignored?" }] } });
    expect(refused).toMatchObject({ status: 409,body: { error: "round_required" } });
    expect(refused.body.message).toContain("--round");
    const opened = await start({ round: { readable: "Phase two" },plan: { op: "set",steps: [{ label: "C" },{ label: "D" }] } });
    expect(opened.status).toBe(200);
    expect(opened.body.disposition).toBe("round_opened");
    expect(opened.body.work.id).toBe(id);
    expect(opened.body.work.plan.rounds.map((round: any) => [round.n,round.state,round.title])).toEqual([[1,"closed",undefined],[2,"open","Phase two"]]);
    expect(opened.body.work.plan.steps.map((step: any) => [step.id,step.round,step.state])).toEqual([["s1",1,"done"],["s2",2,"current"],["s3",2,"open"]]);
    expect((await cards(id)).map((card: any) => card.state)).toEqual(["ended","active"]);
    // The new card shows round 2's steps only.
    const card = (await db.query("SELECT presentation FROM live_activities WHERE work_id=$1 AND state='active'",[id.slice(4)])).rows[0];
    expect(JSON.stringify(card.presentation)).toContain("\"C\"");
    expect(JSON.stringify(card.presentation)).not.toContain("\"A\"");
    // A repeat start now continues the open round.
    expect((await start({ round: { readable: "again" } })).body).toMatchObject({ disposition: "continuing" });
    // Round 2 delivers too; finish after deliver just finishes.
    await deliver("Round two shipped");
    const finished = await request("POST","/api/session/works/current/finish",{ result: "finished",outcome: { readable: "All done" } });
    expect(finished.body.work).toMatchObject({ lifecycle: "finished",outcome: "All done" });
    expect(finished.body.work.plan.rounds.map((round: any) => round.state)).toEqual(["closed","closed"]);
  });

  test("update with plan, status or progress on a delivered work is round_closed; context stays allowed",async () => {
    await start({ plan: { op: "set",steps: [{ label: "A" }] } });
    await deliver();
    for (const change of [{ plan: { op: "add",steps: [{ label: "B" }] } },{ status: { readable: "More" } },{ progress: { done: 1,total: 2 } }]) {
      const refused = await request("PATCH","/api/session/works/current",change);
      expect(refused).toMatchObject({ status: 409,body: { error: "round_closed" } });
    }
    const renamed = await request("PATCH","/api/session/works/current",{ context: { threadName: "Renamed" } });
    expect(renamed.status).toBe(200);
    expect(await cards(renamed.body.work.id)).toHaveLength(1);
  });

  test("finish right after deliver ends the work without a new card or round",async () => {
    const first = await start({});
    await deliver();
    const finished = await request("POST","/api/session/works/current/finish",{ result: "dropped",outcome: { readable: "Not needed" } });
    expect(finished.body.work.lifecycle).toBe("dropped");
    expect(await cards(first.body.work.id)).toHaveLength(1);
  });

  test("nested plans store parent and round; round commands through update are refused while a round is open",async () => {
    const made = await start({ plan: { op: "set",steps: [{ label: "Build",children: [{ label: "Schema" },{ label: "Routes",children: [{ label: "Deliver route" }] }] },{ label: "Ship" }] } });
    expect(made.body.work.plan.steps.map((step: any) => [step.id,step.parent,step.state])).toEqual(
      [["s1",undefined,"open"],["s2","s1","current"],["s3","s1","open"],["s4","s3","open"],["s5",undefined,"open"]]);
    const added = await request("PATCH","/api/session/works/current",{ plan: { op: "add",under: "s1",steps: [{ label: "Docs",detail: "OpenAPI" }] } });
    expect(added.body.work.plan.steps.find((step: any) => step.label === "Docs")).toMatchObject({ parent: "s1",detail: "OpenAPI" });
    const early = await request("PATCH","/api/session/works/current",{ plan: { op: "round",title: "Too soon" } });
    expect(early).toMatchObject({ status: 422,body: { error: "round_open" } });
    const deep = await request("PATCH","/api/session/works/current",{ plan: { op: "add",under: "s4",steps: [{ label: "Too deep" }] } });
    expect(deep).toMatchObject({ status: 422,body: { error: "plan_too_deep" } });
    const stored = (await request("GET","/api/session/works/current")).body.work;
    expect(stored.plan.steps).toHaveLength(6);
  });

  test("a sealed work delivers with the outcome in sealed text only",async () => {
    const sealed = await request("POST","/api/session/works",{ goal: { sealed: true },context,plan: { op: "set",steps: [{},{}] } });
    expect(sealed.status).toBe(201);
    expect((await request("POST","/api/session/works/current/deliver",{ outcome: { readable: "leak" } })).status).toBe(422);
    const done = await request("POST","/api/session/works/current/deliver",{ outcome: { sealed: true },dropRest: true });
    expect(done.body.disposition).toBe("delivered");
    expect(JSON.stringify(done.body.work.plan.rounds)).not.toContain("outcome");
    const reopen = await request("POST","/api/session/works",{ goal: { sealed: true },round: { sealed: true },context,plan: { op: "set",steps: [{}] } });
    expect(reopen.body.disposition).toBe("round_opened");
    expect(reopen.body.work.plan.rounds.map((round: any) => round.title)).toEqual([undefined,undefined]);
  });

  test("derivation loads a delivered work as the owner's turn, and the next round moves it again",async () => {
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    await start({ plan: { op: "set",steps: [{ label: "A" }] } });
    await deliver();
    const state = async () => {
      const [loaded] = await loadOwnerStateInputs(db,principalId,"visible",new Date());
      return deriveOwnerState(loaded!.input);
    };
    expect(await state()).toMatchObject({ state: "waiting_on_you",needsYou: null,now: "waiting_on_you" });
    await start({ round: { readable: "Two" },plan: { op: "set",steps: [{ label: "B" }] } });
    expect((await state()).state).toBe("moving");
  });

  test("history items and owner reads carry parent, round and detail",async () => {
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    const made = await start({ plan: { op: "set",steps: [{ label: "Build",detail: "all of it",children: [{ label: "Schema" }] },{ label: "Docs" }] } });
    expect(made.status).toBe(201);
    const plan = (await loadInboxSnapshot(db,{ principalId })).items.find((item) => item.activity?.plan)!.activity!.plan! as any[];
    expect(plan.find((step) => step.label === "Schema")).toMatchObject({ parent: "s1" });
    expect(plan[0]).toMatchObject({ detail: "all of it" });
    await deliver("Built it");
    const after = (await loadInboxSnapshot(db,{ principalId })).items.map((item) => item.activity).filter((a) => a?.plan).at(0) as any;
    expect(after.plan.map((step: any) => step.state)).toEqual(["done","done","skipped"]);
    expect(after.rounds).toEqual([expect.objectContaining({ n: 1,state: "closed",outcome: "Built it" })]);
    expect(after.roundOutcome).toBe("Built it");
    const owned = (await request("GET","/api/works",undefined,null)).body.works[0];
    expect(owned.plan.rounds).toHaveLength(1);
  });

  test("deliver with open top-level steps is refused (open_steps) and changes nothing; dropRest closes and marks the rest dropped",async () => {
    const first = await start({ plan: { op: "set",steps: [{ label: "B1" },{ label: "B2" },{ label: "B3" },{ label: "B4" }] } });
    const id = first.body.work.id;
    await request("PATCH","/api/session/works/current",{ plan: { op: "next" } });
    const refused = await deliver("Batch 1 done","current",A,false);
    expect(refused).toMatchObject({ status: 422,body: { error: "open_steps" } });
    expect(refused.body.message).toContain("s3 B3, s4 B4");
    expect(refused.body.message).toContain("relo work deliver --drop-rest (an older relo: relo work update --plan");
    const still = (await request("GET","/api/session/works/current")).body.work;
    expect(still.plan.rounds).toBeUndefined();
    expect(still.plan.steps.map((step: any) => step.state)).toEqual(["done","current","open","open"]);
    expect((await cards(id)).map((card: any) => card.state)).toEqual(["active"]);
    const done = await deliver("Batch 1 done","current",A,true);
    expect(done.body.disposition).toBe("delivered");
    expect(done.body.work.plan.steps.map((step: any) => [step.state,step.dropped])).toEqual([["done",undefined],["done",undefined],["skipped",true],["skipped",true]]);
    // The last unfinished step alone needs no flag: the close finishes it.
    const second = await start({ goal: { readable: "Other" },new: true,plan: { op: "set",steps: [{ label: "X" },{ label: "Y" }] } },B);
    expect(second.status).toBe(201);
    await request("PATCH","/api/session/works/current",{ plan: { op: "next" } },B);
    expect((await deliver("Both","current",B,false)).status).toBe(200);
  });

  test("a round opened without a plan carries the unfinished steps as new steps; with a plan it carries nothing",async () => {
    await start({ plan: { op: "set",steps: [{ label: "B1" },{ label: "B2",children: [{ label: "B2a" },{ label: "B2b" }] },{ label: "B3" }] } });
    await deliver("Batch 1");
    const carried = await start({ round: { readable: "Go on" } });
    expect(carried.body.disposition).toBe("round_opened");
    const steps = carried.body.work.plan.steps;
    expect(steps.filter((step: any) => step.round === 1).map((step: any) => step.state)).toEqual(["done","skipped","skipped","skipped","skipped"]);
    expect(steps.filter((step: any) => step.round === 2).map((step: any) => [step.id,step.label,step.parent,step.state,step.carriedFrom]))
      .toEqual([["s6","B2",undefined,"open",1],["s7","B2a","s6","current",1],["s8","B2b","s6","open",1],["s9","B3",undefined,"open",1]]);
    expect(carried.body.work.plan.complete).toBe(false);
    // Closed rounds are never reopened by a later round: with its own plan the round carries nothing.
    await deliver("Batch 2");
    const own = await start({ round: { readable: "Different" },plan: { op: "set",steps: [{ label: "Z" }] } });
    expect(own.body.work.plan.steps.filter((step: any) => step.round === 3).map((step: any) => [step.label,step.carriedFrom])).toEqual([["Z",undefined]]);
  });

  test("a sealed work carries the unfinished steps by id and an add can land after a step",async () => {
    const sealed = await request("POST","/api/session/works",{ goal: { sealed: true },context,plan: { op: "set",steps: [{},{},{}] } });
    expect(sealed.status).toBe(201);
    expect((await deliver("leak")).status).toBe(422);
    const ok = await request("POST","/api/session/works/current/deliver",{ outcome: { sealed: true },dropRest: true });
    expect(ok.body.disposition).toBe("delivered");
    const carried = await request("POST","/api/session/works",{ goal: { sealed: true },round: { sealed: true },context });
    expect(carried.body.disposition).toBe("round_opened");
    expect(carried.body.work.plan.steps.filter((step: any) => step.round === 2).map((step: any) => [step.id,step.label,step.carriedFrom])).toEqual([["s4",undefined,1],["s5",undefined,1]]);
    const added = await request("PATCH","/api/session/works/current",{ plan: { op: "add",after: "s4",steps: [{ id: "s6" }] } });
    expect(added.body.work.plan.steps.filter((step: any) => step.round === 2).map((step: any) => step.id)).toEqual(["s4","s6","s5"]);
  });
});
