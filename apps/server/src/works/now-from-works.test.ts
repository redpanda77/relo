import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { loadNowSummary } from "../api/now-routes.js";
import { loadInboxSnapshot } from "../inbox/queries.js";
import { caller,resetOwner,SECRET,startWork } from "./works-fixture.js";

/** /api/now items read the work behind each card: its plan as steps and its declared waiting. */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Now items from works",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>,call: ReturnType<typeof caller>;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET }); call = caller(app);
  });
  afterAll(async () => db.end());
  beforeEach(async () => { ({ principalId } = await resetOwner(db)); });

  const nowItems = async () => {
    // The route's own loader (the owner phone's read, scope checks aside).
    const now = await loadNowSummary(db,principalId,undefined,undefined);
    return [...now.running,...now.waitingOnYou,...now.quiet,...now.needsYou,...now.paused,...now.recent] as any[];
  };

  test("an item carries the work's plan as steps (skipped omitted) with the current label",async () => {
    const work = await startWork(call,{ plan: { op: "set",steps: [{ label: "Schema" },{ label: "Routes" },{ label: "Tests" }] } });
    expect(work.card).not.toBeNull();
    await call("PATCH",`/api/session/works/${work.id}`,{ plan: { op: "next" } });
    const [item] = await nowItems();
    expect(item.steps).toEqual({ done: 1,total: 3,current: "Routes" });
  });

  test("an item carries the plan progress (U1, U2): top-level count, current step, substeps, labels",async () => {
    const work = await startWork(call,{ plan: { op: "set",steps: [{ label: "Schema" },{ label: "Routes",children: [{ label: "List" },{ label: "Create" },{ label: "Delete" }] },{ label: "Tests" }] } });
    await call("PATCH",`/api/session/works/${work.id}`,{ plan: { op: "next" } });
    await call("PATCH",`/api/session/works/${work.id}`,{ plan: { op: "next" } });
    const [item] = await nowItems();
    expect(item.progress).toEqual({ done: 1,total: 3,currentId: "s2",sub: { done: 1,total: 3 },round: 1,rounds: 1,delivered: false,
      current: 2,fill: 1 / 3,stepLabel: "Routes",subLabel: "Create" });
  });

  test("a delivered round reads delivered in the Now item's progress",async () => {
    const work = await startWork(call,{ plan: { op: "set",steps: [{ label: "Schema" },{ label: "Routes" }] } });
    await call("PATCH",`/api/session/works/${work.id}`,{ plan: { op: "next" } });
    const delivered = await call("POST",`/api/session/works/${work.id}/deliver`,{ outcome: { readable: "Routes done" } });
    expect(delivered.status).toBeLessThan(300);
    const [item] = await nowItems();
    expect(item.progress).toMatchObject({ done: 2,total: 2,currentId: null,round: 1,rounds: 1,delivered: true });
  });

  test("a card update event and the card carry the current step id in the clear",async () => {
    const work = await startWork(call,{ plan: { op: "set",steps: [{ label: "Schema" },{ label: "Routes" }] } });
    await call("PATCH",`/api/session/works/${work.id}`,{ plan: { op: "next" } });
    const events = (await db.query(`SELECT payload FROM notification_events WHERE kind='live_activity' ORDER BY created_at ASC`)).rows;
    expect(events.length).toBeGreaterThan(1);
    expect(events.map((event) => event.payload.liveActivity.stepId)).toEqual(events.map((_,index) => index === 0 ? "s1" : "s2"));
    const card = (await db.query(`SELECT presentation FROM live_activities WHERE work_id=$1 AND state='active'`,[work.id.replace(/^wrk_/,"")])).rows[0];
    const steps = card.presentation.components.find((component: { type: string }) => component.type === "steps");
    expect(steps.plan).toEqual({ done: 1,total: 2,currentId: "s2",sub: null,round: 1,rounds: 1,delivered: false,current: 2,fill: null,stepLabel: "Routes" });
  });

  test("a paused then resumed work is one item, its newest card",async () => {
    const work = await startWork(call,{ plan: { op: "set",steps: [{ label: "Schema" },{ label: "Routes" }] } });
    await startWork(call,{ goal: { readable: "Second" },new: true });
    await call("POST",`/api/session/works/${work.id}/resume`,{});
    const cards = (await db.query(`SELECT state FROM live_activities WHERE work_id=$1`,[work.id.replace(/^wrk_/,"")])).rows;
    expect(cards.map((card) => card.state).sort()).toEqual(["active","ended"]);
    const items = (await nowItems()).filter((item) => item.title === "Ship works");
    expect(items).toHaveLength(1);
  });

  test("a work without a plan has steps null",async () => {
    await startWork(call);
    const [item] = await nowItems();
    expect(item.steps).toBeNull();
    expect(item.progress).toBeNull();
  });

  test("a declared waiting keeps the work moving past T_fresh (waitingSince reaches derive)",async () => {
    const work = await startWork(call);
    await call("PATCH",`/api/session/works/${work.id}`,{ waiting: { reason: { readable: "CI run" } } });
    // Age the declared write past T_fresh (20 min) but keep waiting within T_retire.
    await db.query(`UPDATE works SET declared_at=now()-interval '30 minutes',waiting_since=now()-interval '30 minutes'`);
    await db.query(`UPDATE live_activities SET declared_at=now()-interval '30 minutes' WHERE work_id IS NOT NULL`);
    const [item] = await nowItems();
    expect(item.owner.state).toBe("moving");
    await db.query(`UPDATE works SET waiting_since=NULL,waiting_reason=NULL`);
    const [after] = await nowItems();
    expect(after.owner.state).not.toBe("moving");
  });

  test("a stale 3 of 4 on the work never comes back as a percentage once the work has a plan",async () => {
    const work = await startWork(call,{ progress: { done: 3,total: 4 } });
    const stored = async () => (await db.query(`SELECT progress FROM live_activities WHERE work_id=$1 AND state='active'`,[work.id.replace(/^wrk_/,"")])).rows[0].progress;
    expect(Number(await stored())).toBeCloseTo(0.75);
    await call("PATCH",`/api/session/works/${work.id}`,{ plan: { op: "set",steps: [{ label: "Batches",children: [{ label: "One" },{ label: "Two" },{ label: "Three" }] },{ label: "Verify" }] } });
    const bars = async () => (await db.query(`SELECT presentation FROM live_activities WHERE work_id=$1 AND state='active'`,[work.id.replace(/^wrk_/,"")]))
      .rows[0].presentation.components.filter((component: { type: string }) => component.type === "progress_bar");
    expect(Number(await stored())).toBe(0);
    expect(await bars()).toEqual([]);
    await call("PATCH",`/api/session/works/${work.id}`,{ plan: { op: "next" } });
    expect(Number(await stored())).toBe(0);
    expect(await bars()).toEqual([]);
    // Now and the card agree: two top-level steps, never five.
    const [item] = await nowItems();
    expect(item.steps).toEqual({ done: 0,total: 2,current: "Batches" });
    expect(item.progress).toMatchObject({ done: 0,total: 2,current: 1 });
  });

  test("History and the inbox read the card's plan wire: top-level steps, the current position and its fill",async () => {
    const work = await startWork(call,{ plan: { op: "set",steps: [{ label: "Schema" },{ label: "Routes",children: [{ label: "List" },{ label: "Create" },{ label: "Delete" }] },{ label: "Tests" }] } });
    await call("PATCH",`/api/session/works/${work.id}`,{ plan: { op: "next" } });
    await call("PATCH",`/api/session/works/${work.id}`,{ plan: { op: "next" } });
    const snapshot = await loadInboxSnapshot(db,{ principalId } as never);
    const card = (snapshot.items as any[]).map((item) => item.activity).find((activity) => activity?.steps);
    expect(card.steps).toMatchObject({ done: 1,total: 3,current: "Routes",currentIndex: 2 });
    expect(card.steps.fill).toBeCloseTo(1 / 3);
  });
});
