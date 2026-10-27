import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { generateToken,hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Owner End: POST /api/works/:workId/end",() => {
  let db: Database,app: ReturnType<typeof createApp>,principalId: string,phone: string;
  const owner = "works_owner_abcdefghijklmnopqrstuvwxyz0123456789";
  const other = "works_other_abcdefghijklmnopqrstuvwxyz0123456789";
  const secret = "works-secret-with-at-least-32-characters-long";
  const A = "sessionAAAAAAAAAAAAAAAAAAAAAAAA";
  const B = "sessionBBBBBBBBBBBBBBBBBBBBBBBB";
  const context = { providerName: "Claude Code",project: "relo",threadName: "Release" };

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });
  });
  afterAll(async () => db.end());

  async function pair(forPrincipal: string): Promise<string> {
    const deviceId = randomUUID();
    await db.query(`INSERT INTO devices(id,principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
      live_activity_push_to_start_token,credential_version) VALUES ($1,$2,$3,$4,'Phone','com.example.relo.notifications','1','1','26','sandbox',
      'authorized','authorized','fixture-alert','fixture-start',1)`,[deviceId,forPrincipal,randomUUID(),randomUUID()]);
    const token = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[deviceId,hashToken(token)]);
    return token;
  }

  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    phone = await pair(principalId);
  });

  async function request(method: string,path: string,body?: unknown,token = owner,session: string | null = null) {
    const response = await app.request(path,{
      method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json","idempotency-key": randomUUID(),
        ...(session ? { "relo-session-key": session,"relo-harness": "claude-code" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  const start = (body: Record<string,unknown> = {},session = A) =>
    request("POST","/api/session/works",{ goal: { readable: "Ship the end" },context,...body },owner,session);
  const end = (id: string,token = phone,body: unknown = {}) => request("POST",`/api/works/${id}/end`,body,token);
  /** The work and its card went quiet that long ago (the derivation reads the declared clocks). */
  const age = async (id: string,minutes: number) => {
    await db.query(`UPDATE works SET declared_at=now() - ($2 * interval '1 minute'),updated_at=now() - ($2 * interval '1 minute') WHERE id=$1`,[id.slice(4),minutes]);
    await db.query(`UPDATE live_activities SET declared_at=now() - ($2 * interval '1 minute'),updated_at=now() - ($2 * interval '1 minute') WHERE work_id=$1`,[id.slice(4),minutes]);
  };
  const rows = async () => (await db.query("SELECT count(*)::int AS n FROM notification_events WHERE kind<>'live_activity'")).rows[0].n as number;
  const cardOf = async (id: string) => (await db.query("SELECT state FROM live_activities WHERE work_id=$1 ORDER BY created_at DESC",[id.slice(4)])).rows[0];

  test("a moving work is refused with work_running and stays open",async () => {
    const work = (await start()).body.work;
    const refused = await end(work.id);
    expect(refused).toMatchObject({ status: 409,body: { error: "work_running" } });
    expect((await request("GET",`/api/works/${work.id}`,undefined,phone)).body.work.lifecycle).toBe("open");
    expect((await cardOf(work.id)).state).toBe("active");
  });

  test("a quiet work is dropped as Ended by you, its card ends, and nobody is notified",async () => {
    const work = (await start({ plan: { op: "set",steps: [{ label: "A" },{ label: "B" }] } })).body.work;
    await age(work.id,25);
    const before = await rows();
    const ended = await end(work.id);
    expect(ended.status).toBe(200);
    expect(ended.body.work).toMatchObject({ lifecycle: "dropped",outcome: "Ended by you",sealed: false });
    expect((await cardOf(work.id)).state).toBe("ended");
    expect(await rows()).toBe(before);
    // Ended means ended.
    expect((await end(work.id)).body.error).toBe("work_finished");
  });

  test("the card id Now lists a work by ends it too, and another account's card is unknown",async () => {
    const work = (await start()).body.work;
    await age(work.id,25);
    const card = (await db.query("SELECT id FROM live_activities WHERE work_id=$1",[work.id.slice(4)])).rows[0].id as string;
    await bootstrapOwner(db,"other",other);
    const stranger = await pair((await db.query("SELECT id FROM owner_principals WHERE handle='other'")).rows[0].id);
    expect((await end(`act_${card}`,stranger)).status).toBe(404);
    expect(await end(`act_${card}`)).toMatchObject({ status: 200,body: { work: { lifecycle: "dropped",outcome: "Ended by you" } } });
  });

  test("a paused work can be ended",async () => {
    const work = (await start()).body.work;
    await request("POST","/api/session/works/current/pause",{ status: { readable: "Break" } },owner,A);
    expect(await end(work.id)).toMatchObject({ status: 200,body: { work: { lifecycle: "dropped",outcome: "Ended by you" } } });
  });

  test("a delivered work finishes with its last round's outcome, in its first hour and after",async () => {
    const first = (await start({ plan: { op: "set",steps: [{ label: "A" }] } })).body.work;
    await request("POST","/api/session/works/current/deliver",{ outcome: { readable: "Login works on iOS" } },owner,A);
    const before = await rows();
    const ended = await end(first.id);
    expect(ended.status).toBe(200);
    expect(ended.body.work).toMatchObject({ lifecycle: "finished",outcome: "Login works on iOS" });
    expect(await rows()).toBe(before);

    const second = (await start({ goal: { readable: "Another" } },B)).body.work;
    await request("POST","/api/session/works/current/deliver",{ outcome: { readable: "Shipped" } },owner,B);
    await age(second.id,3 * 60);
    expect((await end(second.id)).body.work).toMatchObject({ lifecycle: "finished",outcome: "Shipped" });
  });

  test("a sealed work ends with no readable outcome",async () => {
    const work = (await start({ goal: { sealed: true },plan: { op: "set",steps: [{},{}] } })).body.work;
    await age(work.id,30);
    const ended = await end(work.id);
    expect(ended.status).toBe(200);
    expect(ended.body.work).toMatchObject({ lifecycle: "dropped",sealed: true,outcome: null,goal: null });

    const delivered = (await start({ goal: { sealed: true } },B)).body.work;
    await request("POST","/api/session/works/current/deliver",{ outcome: { sealed: true } },owner,B);
    expect((await end(delivered.id)).body.work).toMatchObject({ lifecycle: "finished",sealed: true,outcome: null });
  });

  test("another account's work answers like an unknown id; the work does not move",async () => {
    const work = (await start()).body.work;
    await age(work.id,30);
    await bootstrapOwner(db,"other",other);
    const otherPrincipal = (await db.query("SELECT id FROM owner_principals WHERE handle='other'")).rows[0].id;
    const stranger = await pair(otherPrincipal);
    const foreign = await end(work.id,stranger);
    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(await end(`wrk_${randomUUID()}`,stranger));
    expect((await request("GET",`/api/works/${work.id}`,undefined,phone)).body.work.lifecycle).toBe("open");
  });

  test("only the owner's phone: not a session, not an API key, not a body",async () => {
    const work = (await start()).body.work;
    await age(work.id,30);
    expect((await end(work.id,owner)).status).toBe(403);
    expect((await request("POST",`/api/works/${work.id}/end`,{},phone,A)).status).toBe(403);
    expect((await end(work.id,phone,{ outcome: { readable: "x" } })).status).toBe(400);
    expect((await end("wrk_not-an-id")).status).toBe(404);
    expect((await end(work.id)).status).toBe(200);
  });
});
