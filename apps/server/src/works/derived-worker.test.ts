import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { retireByPolicy } from "../activity-commands/retirement.js";
import { createApp } from "../app.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { createDerivedWorker } from "./derived-worker.js";
import { caller,resetOwner,SECRET,startWork } from "./works-fixture.js";

/**
 * The worker's derived pass over works' cards (1.7, 1.5d, 2.17): retirement by derived state and
 * relevance, display only (never a declared field), the next change time, and wakes on time alone.
 */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const sessions = ["sessionW1xxxxxxxxxxxxxxxxxxxxxxx","sessionW2xxxxxxxxxxxxxxxxxxxxxxx",
  "sessionW3xxxxxxxxxxxxxxxxxxxxxxx","sessionW4xxxxxxxxxxxxxxxxxxxxxxx"];

suite("derived worker over works",() => {
  let db: Database,call: ReturnType<typeof caller>;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    call = caller(createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET }));
  });
  afterAll(async () => db.end());
  beforeEach(async () => { await resetOwner(db); });

  const declared = async () => JSON.stringify([
    (await db.query("SELECT * FROM works ORDER BY id")).rows,
    (await db.query("SELECT id,state,title,status,sequence,declared_at,updated_at,ended_at FROM live_activities ORDER BY id")).rows,
  ]);
  const leases = async () => (await db.query(`SELECT l.state,l.reason,a.work_id FROM live_activity_presentation_leases l
    JOIN live_activities a ON a.id=l.live_activity_id ORDER BY a.created_at`)).rows;
  const age = async (workId: string,minutes: number) => {
    await db.query(`UPDATE works SET declared_at=now()-make_interval(mins=>$2),created_at=now()-make_interval(mins=>$2) WHERE id=$1`,[workId,minutes]);
    await db.query(`UPDATE live_activities SET declared_at=now()-make_interval(mins=>$2) WHERE work_id=$1`,[workId,minutes]);
  };
  const internal = (id: string) => id.replace(/^wrk_/,"");

  test("a fresh card is kept, its row and work untouched, and the pass names the next change",async () => {
    await startWork(call,{},sessions[0]);
    expect((await leases()).length).toBe(1);
    const before = await declared();
    const pass = await retireByPolicy(db,"sandbox");
    expect(pass.retired).toBe(0);
    expect(pass.nextAt).not.toBeNull();
    expect(pass.nextAt!.valueOf()).toBeGreaterThan(Date.now());
    expect(await declared()).toBe(before);
  });

  test("a card with no evidence for T_retire leaves this phone (display only); the work stays open",async () => {
    const work = await startWork(call,{},sessions[0]);
    await age(internal(work.id),61);
    const before = await declared();
    expect((await retireByPolicy(db,"sandbox")).retired).toBe(1);
    expect(await leases()).toMatchObject([{ state: "not_presented",reason: "retired_no_signal" }]);
    expect(await declared()).toBe(before);
    expect((await db.query("SELECT lifecycle FROM works")).rows[0].lifecycle).toBe("open");
  });

  test("a fourth card is retired by derived relevance; a work that needs you keeps its slot",async () => {
    const works = [];
    for (const session of sessions) works.push(await startWork(call,{},session));
    // The oldest-started work holds a permission prompt (hooks): needs you, highest relevance.
    const { rows: [{ principal_id: principalId }] } = await db.query("SELECT principal_id FROM works LIMIT 1");
    await db.query(`INSERT INTO agent_sessions (principal_id,session_hash,harness,phase,phase_since,last_seen_at,seq,started_at)
      VALUES ($1,$2,'claude-code','waiting',now()+interval '1 second',now()+interval '1 second',1,now())`,[principalId,sessions[0]]);
    const pass = await retireByPolicy(db,"sandbox",200,{ now: new Date(Date.now() + 5_000) });
    expect(pass.retired).toBe(1);
    const rows = await leases();
    expect(rows.filter((row) => row.state === "not_presented")).toMatchObject([{ reason: "over_card_limit" }]);
    expect(rows.find((row) => row.work_id === internal(works[0].id))?.state).not.toBe("not_presented");
  });

  test("a hook that moves a card pushes one update with the new state; the next pass pushes nothing",async () => {
    await startWork(call,{},sessions[0]);
    const updates = async () => Number((await db.query(
      `SELECT count(*) FROM notification_events WHERE payload#>>'{liveActivity,operation}'='update' AND idempotency_key LIKE '%:restale'`)).rows[0].count);
    const { rows: [{ principal_id: principalId }] } = await db.query("SELECT principal_id FROM works LIMIT 1");
    expect((await retireByPolicy(db,"sandbox")).restaled).toBe(0);
    // The session's permission prompt arrives from a hook: the card needs you, with no producer write.
    await db.query(`INSERT INTO agent_sessions (principal_id,session_hash,harness,phase,phase_since,last_seen_at,seq,started_at)
      VALUES ($1,$2,'claude-code','waiting',now()+interval '1 second',now()+interval '1 second',1,now())`,[principalId,sessions[0]]);
    const later = new Date(Date.now() + 5_000);
    expect((await retireByPolicy(db,"sandbox",200,{ now: later })).restaled).toBe(1);
    expect(await updates()).toBe(1);
    expect((await retireByPolicy(db,"sandbox",200,{ now: later })).restaled).toBe(0);
    expect(await updates()).toBe(1);
  });

  test("a time-only derived change between passes wakes the account once; no change wakes nobody",async () => {
    const work = await startWork(call,{},sessions[0]);
    const worker = createDerivedWorker(db,"sandbox");
    expect((await worker.pass()).woken).toBe(0);
    expect((await worker.pass()).woken).toBe(0);
    // T_fresh passes by time alone: moving → stale.
    await age(internal(work.id),21);
    expect((await worker.pass()).woken).toBe(0);
    const since = new Date(Date.now() - 2 * 60_000);
    expect((await retireByPolicy(db,"sandbox",200,{ since })).woken).toBe(1);
  });
});
