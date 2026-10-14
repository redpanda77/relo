import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { caller,CONTEXT,resetOwner,SECRET,SESSION_A,SESSION_B,startWork } from "./works-fixture.js";

/** Notices during an open work fold into it (2.13): recorded, no buzz, the work's declared fields untouched. */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("notices on works",() => {
  let db: Database,call: ReturnType<typeof caller>;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    call = caller(createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET }));
  });
  afterAll(async () => db.end());
  beforeEach(async () => { await resetOwner(db); });

  const notify = (session: string | null) => call("POST","/api/notifications",
    { title: "Release",body: "Tests passed",sourceName: "Claude Code",context: CONTEXT },session);
  const jobs = async (eventId: string) => Number((await db.query("SELECT count(*) FROM delivery_jobs WHERE notification_event_id=$1",
    [eventId.replace(/^ntf_/,"")])).rows[0].count);

  test("a notice during the session's open work folds into it: no delivery job, declared fields untouched",async () => {
    const work = await startWork(call,{ status: { readable: "Building" } });
    const before = (await db.query("SELECT goal,status,plan,lifecycle,outcome FROM works")).rows[0];
    const sent = await notify(SESSION_A);
    expect(sent.status,JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({ folded: true,workId: work.id,queued: 0 });
    expect(await jobs(sent.body.eventId)).toBe(0);
    expect((await db.query("SELECT goal,status,plan,lifecycle,outcome FROM works")).rows[0]).toEqual(before);
    expect((await db.query("SELECT folded FROM notification_events WHERE id=$1",[sent.body.eventId.slice(4)])).rows[0].folded).toBe(true);
  });

  test("another session's notice, or one outside any session, stays standalone",async () => {
    await startWork(call);
    for (const session of [SESSION_B,null]) {
      const sent = await notify(session);
      expect(sent.status,JSON.stringify(sent.body)).toBe(201);
      expect(sent.body.folded).toBeUndefined();
    }
  });

  test("after finish the notice is standalone",async () => {
    const work = await startWork(call);
    await call("POST",`/api/session/works/${work.id}/finish`,{ result: "finished",outcome: { readable: "Shipped" } });
    const sent = await notify(SESSION_A);
    expect(sent.body.folded).toBeUndefined();
  });
});
