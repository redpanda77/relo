import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { generateToken,hashToken } from "../auth.js";
import { createApp } from "../app.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { caller,CONTEXT,OWNER_TOKEN,resetOwner,SECRET,SESSION_A,SESSION_B,startWork } from "./works-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Session works: handoff",() => {
  let db: Database,app: ReturnType<typeof createApp>,call: ReturnType<typeof caller>,principalId: string;
  const SESSION_C = "sessionGCCCCCCCCCCCCCCCCCCCCCCC";

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET });
    call = caller(app);
  });
  afterAll(async () => db.end());
  beforeEach(async () => { principalId = (await resetOwner(db)).principalId; });

  async function otherCredential(onAccount = principalId) {
    const token = generateToken();
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash) VALUES ($1,$2,$3)",[onAccount,`k-${randomUUID()}`,hashToken(token)]);
    return async (method: string,path: string,body?: unknown,session = SESSION_B) => {
      const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
        "idempotency-key": randomUUID(),"relo-session-key": session,"relo-harness": "claude-code" },body: body === undefined ? null : JSON.stringify(body) });
      return { status: response.status,body: await response.json().catch(() => null) as any };
    };
  }
  const handoff = (next = "Wire the CLI verb",session = SESSION_A) =>
    call("POST","/api/session/works/current/handoff",{ next: { readable: `Handing off: ${next}` } },session);
  const takeOver = (handle: string,session = SESSION_B,via = call) => via("POST","/api/session/works",{ from: handle },session);
  const cards = async (workId: string) =>
    (await db.query("SELECT state,status,session_key FROM live_activities WHERE work_id=$1 ORDER BY created_at",[workId.slice(4)])).rows;

  test("handoff keeps the work, its round and its card open, sets the status and returns the handle once",async () => {
    const work = await startWork(call,{ plan: { op: "set",steps: [{ label: "A" },{ label: "B" }] } });
    const done = await handoff();
    expect(done.status).toBe(200);
    expect(done.body.disposition).toBe("handed_off");
    expect(done.body.work).toMatchObject({ id: work.id,lifecycle: "open",status: "Handing off: Wire the CLI verb" });
    expect(done.body.work.plan.rounds?.every((round: any) => round.state === "open") ?? true).toBe(true);
    expect(done.body.handoff.handle).toMatch(/^rh_[A-Za-z0-9_-]{32,}$/);
    expect(Date.parse(done.body.handoff.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(await cards(work.id)).toEqual([expect.objectContaining({ state: "active",session_key: SESSION_A })]);
    const stored = JSON.stringify((await db.query("SELECT * FROM work_handoffs")).rows);
    expect(stored).not.toContain(done.body.handoff.handle);
    expect((await call("GET","/api/session/works/current")).body.work.status).toBe("Handing off: Wire the CLI verb");
    // A read never returns the handle again.
    expect(JSON.stringify((await call("GET","/api/session/works")).body)).not.toContain(done.body.handoff.handle);
  });

  test("a new session takes the work over; the old one loses it; the card goes on",async () => {
    const work = await startWork(call,{ plan: { op: "set",steps: [{ label: "A" }] } });
    const { body: { handoff: { handle } } } = await handoff();
    const taken = await takeOver(handle);
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ disposition: "taken_over",work: { id: work.id,lifecycle: "open" } });
    expect(taken.body.work.plan.steps).toHaveLength(1);
    expect((await call("GET","/api/session/works/current",undefined,SESSION_A)).status).toBe(404);
    expect((await call("GET","/api/session/works",undefined,SESSION_A)).body.open).toBeNull();
    expect((await call("GET","/api/session/works/current",undefined,SESSION_B)).body.work.id).toBe(work.id);
    expect((await call("PATCH",`/api/session/works/${work.id}`,{ status: { readable: "x" } },SESSION_A)).status).toBe(404);
    const update = await call("PATCH","/api/session/works/current",{ status: { readable: "Continuing" } },SESSION_B);
    expect(update.status).toBe(200);
    const rows = await cards(work.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "active",session_key: SESSION_B,status: "Continuing" });
  });

  test("a handle is single use; a replayed take-over by the same session answers the first result",async () => {
    await startWork(call);
    const { body: { handoff: { handle } } } = await handoff();
    expect((await takeOver(handle)).status).toBe(200);
    const replay = await takeOver(handle);
    expect(replay).toMatchObject({ status: 200,body: { disposition: "taken_over",replayed: true } });
    const third = await takeOver(handle,SESSION_C);
    expect(third).toMatchObject({ status: 409,body: { error: "handoff_invalid" } });
    expect((await call("GET","/api/session/works/current",undefined,SESSION_B)).status).toBe(200);
  });

  test("an unknown or expired handle is refused with one neutral answer",async () => {
    await startWork(call);
    const { body: { handoff: { handle } } } = await handoff();
    const unknown = await takeOver("rh_nope-nope-nope-nope-nope-nope-nope");
    await db.query("UPDATE work_handoffs SET expires_at=statement_timestamp() - interval '1 second'");
    const expired = await takeOver(handle);
    expect(unknown.status).toBe(409);
    expect(expired).toEqual(unknown);
    expect(unknown.body.error).toBe("handoff_invalid");
    expect((await call("GET","/api/session/works/current",undefined,SESSION_A)).status).toBe(200);
  });

  test("another computer (credential) or another account is refused the same way",async () => {
    await startWork(call);
    const { body: { handoff: { handle } } } = await handoff();
    const unknown = await takeOver("rh_nope-nope-nope-nope-nope-nope-nope");
    const sameAccountOtherComputer = await otherCredential();
    expect(await takeOver(handle,SESSION_B,sameAccountOtherComputer as any)).toEqual(unknown);
    const strangerAccount = (await db.query("INSERT INTO owner_principals(handle) VALUES ('stranger') RETURNING id")).rows[0].id;
    expect(await takeOver(handle,SESSION_B,(await otherCredential(strangerAccount)) as any)).toEqual(unknown);
    // The refused tries did not spend the handle.
    expect((await takeOver(handle)).status).toBe(200);
  });

  test("a new handoff invalidates the previous handle",async () => {
    await startWork(call);
    const first = (await handoff("one")).body.handoff.handle;
    const second = (await handoff("two")).body.handoff.handle;
    expect(second).not.toBe(first);
    expect((await takeOver(first)).status).toBe(409);
    expect((await db.query("SELECT count(*)::int AS n FROM work_handoffs")).rows[0].n).toBe(1);
    const taken = await takeOver(second);
    expect(taken.status).toBe(200);
    expect(taken.body.work.status).toBe("Handing off: two");
  });

  test("taking over parks the caller's own open work",async () => {
    const mine = await startWork(call,{ goal: { readable: "Something else" } },SESSION_B);
    const handed = await startWork(call,{ goal: { readable: "The big one" } });
    const { body: { handoff: { handle } } } = await handoff();
    const taken = await takeOver(handle);
    expect(taken.status).toBe(200);
    expect(taken.body.work.id).toBe(handed.id);
    expect(taken.body.parked.map((work: any) => work.id)).toEqual([mine.id]);
    const state = (await call("GET","/api/session/works",undefined,SESSION_B)).body;
    expect(state.open.id).toBe(handed.id);
    expect(state.parked.map((work: any) => work.id)).toEqual([mine.id]);
  });

  test("a finished work is refused for handoff and for take-over",async () => {
    await startWork(call);
    const { body: { handoff: { handle } } } = await handoff();
    await call("POST","/api/session/works/current/finish",{ result: "finished",outcome: { readable: "Done" } });
    const refused = await takeOver(handle);
    expect(refused).toMatchObject({ status: 409,body: { error: "handoff_finished" } });
    const again = await handoff();
    expect(again).toMatchObject({ status: 409,body: { error: "not_open" } });
    const work = await startWork(call,{ goal: { readable: "Next" } });
    await call("POST","/api/session/works/current/finish",{ result: "dropped",outcome: { readable: "No" } });
    const finishedHandoff = await call("POST",`/api/session/works/${work.id}/handoff`,{ next: { readable: "x" } });
    expect(finishedHandoff).toMatchObject({ status: 409,body: { error: "work_finished" } });
  });

  test("a delivered round, a foreign session and sealed text follow the usual rules",async () => {
    const work = await startWork(call);
    expect((await call("POST",`/api/session/works/${work.id}/handoff`,{ next: { readable: "x" } },SESSION_B)).status).toBe(404);
    expect((await call("POST","/api/session/works/current/handoff",{},SESSION_A)).status).toBe(400);
    await call("POST","/api/session/works/current/deliver",{ outcome: { readable: "Shipped" } });
    expect((await handoff()).body.error).toBe("round_closed");
    const sealed = await call("POST","/api/session/works",{ goal: { sealed: true },context: CONTEXT,round: { sealed: true } },SESSION_C);
    expect(sealed.status).toBe(201);
    expect((await call("POST","/api/session/works/current/handoff",{ next: { readable: "leak" } },SESSION_C)).status).toBe(422);
    const ok = await call("POST","/api/session/works/current/handoff",{ next: { sealed: true },sealed: { v: 1 },producerSealed: { v: 1,self: true } },SESSION_C);
    expect(ok.status).toBe(200);
    const taken = await takeOver(ok.body.handoff.handle,SESSION_B);
    expect(taken.body.work).toMatchObject({ sealed: true,goal: null,producerSealed: { self: true } });
  });

  test("the owner credential header-less call is refused like other session routes",async () => {
    await startWork(call);
    expect((await call("POST","/api/session/works/current/handoff",{ next: { readable: "x" } },null)).status).toBe(400);
    expect(OWNER_TOKEN.length).toBeGreaterThan(0);
  });
});
