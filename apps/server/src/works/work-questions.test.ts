import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { loadNowSummary } from "../api/now-routes.js";
import { createApp } from "../app.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { caller,CONTEXT,resetOwner,SECRET,SESSION_A,startWork } from "./works-fixture.js";

/** Questions on works (2.13, spec 7): asking attaches to the work, puts it under Needs you, never ends it. */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("questions on works",() => {
  let db: Database,principalId: string,call: ReturnType<typeof caller>;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    call = caller(createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET }));
  });
  afterAll(async () => db.end());
  beforeEach(async () => { ({ principalId } = await resetOwner(db)); });

  const ask = async (cardId: string) => {
    const asked = await call("POST",`/api/live-activities/${cardId}/wait`,{ type: "approval",prompt: "Deploy now?",expiresInSeconds: 120 },null);
    expect(asked.status,JSON.stringify(asked.body)).toBe(201);
    return asked.body;
  };

  test("a question on the work's card is a declared write of the work and never changes its declared fields",async () => {
    const work = await startWork(call,{ status: { readable: "Building" },plan: { op: "set",steps: [{ label: "A" },{ label: "B" }] } });
    await db.query("UPDATE works SET declared_at=now()-interval '5 minutes'");
    const before = (await db.query("SELECT * FROM works")).rows[0];
    await ask(work.card.id);
    const after = (await db.query("SELECT * FROM works")).rows[0];
    expect(after.declared_at.valueOf()).toBeGreaterThan(before.declared_at.valueOf());
    expect({ ...after,declared_at: null,updated_at: null }).toEqual({ ...before,declared_at: null,updated_at: null });
  });

  test("the work needs you while the question is pending; expiry never ends the work",async () => {
    const work = await startWork(call);
    const asked = await ask(work.card.id);
    const now = await loadNowSummary(db,principalId,undefined,undefined);
    expect(now.needsYou.map((item) => item.question?.standing)).toEqual(["pending"]);
    const id = (asked.interaction?.id ?? asked.interactionId) as string;
    await db.query("UPDATE interaction_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[id.replace(/^int_/,"")]);
    await call("GET",`/api/interactions/${id}`,undefined,null);
    expect((await db.query("SELECT lifecycle FROM works")).rows[0].lifecycle).toBe("open");
    const update = await call("PATCH",`/api/session/works/${work.id}`,{ status: { readable: "Still going" } });
    expect(update.status).toBe(200);
  });

  test("a question asked in the session without the card (in-app fallback) attaches to the open work by id",async () => {
    const work = await startWork(call);
    const asked = await call("POST","/api/interactions",{ type: "approval",prompt: "Deploy now?",title: "Release",
      expiresInSeconds: 120,answerInApp: true,context: CONTEXT },SESSION_A);
    expect(asked.status,JSON.stringify(asked.body)).toBeLessThan(300);
    const stored = (await db.query("SELECT work_id FROM interaction_requests")).rows[0];
    expect(stored.work_id).toBe(work.id.replace(/^wrk_/,""));
    const now = await loadNowSummary(db,principalId,undefined,undefined);
    expect(now.needsYou.map((item) => [item.owner.state,item.question?.standing])).toEqual([["needs_you","pending"]]);
  });

  test("a question from outside any session never attaches to a work",async () => {
    await startWork(call);
    const asked = await call("POST","/api/interactions",{ type: "approval",prompt: "Deploy now?",title: "Release",
      expiresInSeconds: 120,answerInApp: true,context: CONTEXT },null);
    expect(asked.status,JSON.stringify(asked.body)).toBeLessThan(300);
    expect((await db.query("SELECT work_id FROM interaction_requests")).rows[0].work_id).toBeNull();
  });

  test("a hookless session row carries the work's computer and source and only exists while the work is live",async () => {
    const work = await startWork(call,{ context: { ...CONTEXT,computer: "Studio" } });
    let now = await loadNowSummary(db,principalId,undefined,undefined);
    expect(now.sessions.sessions).toMatchObject([{ computer: "Studio",source: "Claude Code" }]);
    expect(now.running[0]?.sessionId ?? now.quiet[0]?.sessionId).toBe(now.sessions.sessions[0]!.id);
    await call("POST",`/api/session/works/${work.id}/finish`,{ result: "finished",outcome: { readable: "Shipped" } });
    now = await loadNowSummary(db,principalId,undefined,undefined);
    expect(now.sessions.sessions).toEqual([]);
  });
});
