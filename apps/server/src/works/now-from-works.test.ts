import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { loadNowSummary } from "../api/now-routes.js";
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
    return [...now.running,...now.waitingOnYou,...now.quiet,...now.needsYou,...now.paused] as any[];
  };

  test("an item carries the work's plan as steps (skipped omitted) with the current label",async () => {
    const work = await startWork(call,{ plan: { op: "set",steps: [{ label: "Schema" },{ label: "Routes" },{ label: "Tests" }] } });
    expect(work.card).not.toBeNull();
    await call("PATCH",`/api/session/works/${work.id}`,{ plan: { op: "next" } });
    const [item] = await nowItems();
    expect(item.steps).toEqual({ done: 1,total: 3,current: "Routes" });
  });

  test("a work without a plan has steps null",async () => {
    await startWork(call);
    const [item] = await nowItems();
    expect(item.steps).toBeNull();
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
});
