import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { createDatabase,type Database } from "../db.js";
import { createNotificationContentCipher } from "../notification-content.js";
import { migrate } from "../migrate.js";
import { caller,resetOwner,SECRET,startWork } from "../works/works-fixture.js";
import { generateToken,hashToken } from "../auth.js";
import { retireByPolicy } from "./retirement.js";

/** The ActivityKit 8 h limit: a card whose work still needs the owner is replaced; other work ends. */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const SESSION = "sessionL1xxxxxxxxxxxxxxxxxxxxxxx";

suite("card at the Live Activity limit",() => {
  let db: Database,call: ReturnType<typeof caller>;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    call = caller(createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET }));
  });
  afterAll(async () => db.end());
  beforeEach(async () => { await resetOwner(db); });

  const present = (hours: number) => db.query(
    `UPDATE live_activity_presentation_leases SET presented_at=now()-make_interval(hours=>$1)`,[hours]);
  const waiting = async () => {
    const { rows: [{ principal_id: principalId }] } = await db.query("SELECT principal_id FROM works LIMIT 1");
    await db.query(`INSERT INTO agent_sessions (principal_id,session_hash,harness,phase,phase_since,last_seen_at,seq,started_at)
      VALUES ($1,$2,'claude-code','waiting',now()+interval '1 second',now()+interval '1 second',1,now())`,[principalId,SESSION]);
  };
  const soon = () => new Date(Date.now() + 5_000);
  const commands = async () => (await db.query(
    `SELECT payload->'liveActivity' AS c,idempotency_key FROM notification_events
     WHERE idempotency_key LIKE 'server:%' ORDER BY created_at,id`)).rows;
  const starts = async () => (await commands()).filter((row) => row.c.operation === "start");

  test("needs you at the limit: old card ended, one quiet new card for the same work, plan and card",async () => {
    const work = await startWork(call,{},SESSION);
    await waiting();
    const before = (await db.query("SELECT id,work_id,sequence,presentation FROM live_activities")).rows;
    await present(9);
    expect((await retireByPolicy(db,"sandbox",200,{ now: soon() })).retired).toBe(1);
    const all = await commands();
    // Only a push-to-start: the old generation's frames are superseded and ActivityKit ended it itself.
    expect(all.map((row) => row.c.operation)).toEqual(["start"]);
    const start = all[0]!.c;
    expect(start).toMatchObject({ alertOwner: "none",interaction: null,quietRestart: true,
      activityId: `act_${before[0].id}`,generation: 2 });
    expect(start.owner.state).toBe("needs_you");
    expect((await db.query("SELECT count(*)::int AS n FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id WHERE j.transport='live_activity_start' AND e.idempotency_key LIKE 'server:%'")).rows[0].n).toBe(1);
    expect(await db.query("SELECT count(*)::int AS n FROM works")).toMatchObject({ rows: [{ n: 1 }] });
    expect((await db.query("SELECT id,work_id,sequence,presentation FROM live_activities")).rows).toEqual(before);
    expect((await db.query("SELECT generation::int AS g FROM live_activities")).rows).toEqual([{ g: 2 }]);
    expect((await db.query("SELECT count(*)::int AS n FROM live_activity_update_tokens")).rows[0].n).toBe(0);
    expect(before[0].work_id).toBe(work.id.replace(/^wrk_/,""));
    expect((await db.query("SELECT state,reason FROM live_activity_presentation_leases")).rows)
      .toEqual([{ state: "background",reason: "activitykit_limit_replaced" }]);
  });

  test("moving work at the limit is retired with no new card",async () => {
    await startWork(call,{},SESSION);
    await present(9);
    expect((await retireByPolicy(db,"sandbox",200,{ now: soon() })).retired).toBe(1);
    expect((await commands()).map((row) => row.c.operation)).toEqual(["end"]);
    expect((await db.query("SELECT presented_at FROM live_activity_presentation_leases")).rows[0].presented_at).toBeNull();
    expect(await starts()).toHaveLength(0);
    expect((await db.query("SELECT state,reason FROM live_activity_presentation_leases")).rows)
      .toEqual([{ state: "not_presented",reason: "activitykit_limit" }]);
  });

  test("a second pass within 8 h of the replacement starts no third card",async () => {
    await startWork(call,{},SESSION);
    await waiting();
    await present(9);
    await retireByPolicy(db,"sandbox",200,{ now: soon() });
    expect((await retireByPolicy(db,"sandbox",200,{ now: soon() })).retired).toBe(0);
    await retireByPolicy(db,"sandbox",200,{ now: new Date(Date.now() + 7 * 3_600_000) });
    expect(await starts()).toHaveLength(1);
  });

  const oldToken = (generation: number) => db.query(
    `INSERT INTO live_activity_update_tokens(live_activity_id,device_id,generation,token,environment,native_activity_id)
     SELECT a.id,l.device_id,$1,'old-token','sandbox','native-old' FROM live_activities a
     JOIN live_activity_presentation_leases l ON l.live_activity_id=a.id`,[generation]);

  test("a dismissal of the replaced generation leaves the new card's lease and tokens intact",async () => {
    await startWork(call,{},SESSION);
    await waiting();
    await oldToken(1);
    await present(9);
    await retireByPolicy(db,"sandbox",200,{ now: soon() });
    const { rows: [{ id,device_id: deviceId }] } = await db.query(
      "SELECT a.id,l.device_id FROM live_activities a JOIN live_activity_presentation_leases l ON l.live_activity_id=a.id");
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[deviceId,hashToken(credential)]);
    const app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET });
    const dismiss = (query = "") => app.request(`/api/devices/self/live-activities/act_${id}/dismissed${query}`,
      { method: "POST",headers: { authorization: `Bearer ${credential}` } });
    // The phone registers the new card's token, then the old card's dismissal arrives naming generation 1.
    await oldToken(2).catch(() => undefined);
    await db.query(`UPDATE live_activity_update_tokens SET generation=2`);
    expect(await (await dismiss("?generation=1")).json()).toMatchObject({ changed: false });
    // A dismissal that names no generation, before the new card has a token, is the old card's.
    await db.query("DELETE FROM live_activity_update_tokens");
    expect(await (await dismiss()).json()).toMatchObject({ changed: false });
    expect((await db.query("SELECT state,reason FROM live_activity_presentation_leases")).rows)
      .toEqual([{ state: "background",reason: "activitykit_limit_replaced" }]);
    await db.query(`INSERT INTO live_activity_update_tokens(live_activity_id,device_id,generation,token,environment,native_activity_id)
      VALUES ($1,$2,2,'new-token','sandbox','native-new')`,[id,deviceId]);
    expect(await (await dismiss("?generation=1")).json()).toMatchObject({ changed: false });
    expect((await db.query("SELECT generation::int AS g FROM live_activity_update_tokens")).rows).toEqual([{ g: 2 }]);
    // Dismissing the new card itself still works.
    expect(await (await dismiss("?generation=2")).json()).toMatchObject({ changed: true });
    expect((await db.query("SELECT state,presented_at FROM live_activity_presentation_leases")).rows)
      .toEqual([{ state: "not_presented",presented_at: null }]);
  });

  test("with no push-to-start token the waiting card is retired and one quiet notification is sent per work per 8 h",async () => {
    await startWork(call,{},SESSION);
    await waiting();
    await db.query("UPDATE devices SET live_activity_push_to_start_token=NULL");
    await present(9);
    const contentCipher = createNotificationContentCipher(SECRET);
    await retireByPolicy(db,"sandbox",200,{ now: soon(),contentCipher });
    expect(await starts()).toHaveLength(0);
    const notes = async () => (await db.query(
      `SELECT title FROM notification_events WHERE idempotency_key LIKE 'limit-waiting:%'`)).rows;
    expect((await notes()).length).toBe(1);
    expect((await notes())[0].title).toMatch(/^Still waiting for you: /);
    await retireByPolicy(db,"sandbox",200,{ now: soon(),contentCipher });
    expect((await notes()).length).toBe(1);
  });

  test("a card retired while its Mac slept comes back quietly when the prompt is still waiting",async () => {
    await startWork(call,{},SESSION);
    const { rows: [{ principal_id: principalId }] } = await db.query("SELECT principal_id FROM works LIMIT 1");
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    // The work was last declared 30 minutes ago (a declared write within T_fresh would keep it "moving").
    await db.query(`UPDATE works SET declared_at=now()-interval '30 minutes',created_at=now()-interval '30 minutes'`);
    await db.query(`UPDATE live_activities SET declared_at=now()-interval '30 minutes'`);
    await db.query(`INSERT INTO agent_sessions (principal_id,session_hash,harness,phase,phase_since,last_seen_at,heartbeat_at,seq,started_at)
      VALUES ($1,$2,'claude-code','waiting',$3,$3,$3,1,now())`,[principalId,SESSION,at(0.1)]);
    const first = await retireByPolicy(db,"sandbox",200,{ now: at(0.2) });
    expect(first.retired).toBe(0);
    const before = (await db.query("SELECT generation::int AS g FROM live_activities")).rows[0].g;
    // The Mac sleeps: no heartbeat for 11 minutes, the prompt is silent and the card leaves the Lock Screen.
    expect((await retireByPolicy(db,"sandbox",200,{ now: at(11.5) })).retired).toBe(1);
    expect((await db.query("SELECT state,reason FROM live_activity_presentation_leases")).rows)
      .toEqual([{ state: "not_presented",reason: "retired_stopped_responding" }]);
    expect(await starts()).toHaveLength(0);
    // The heartbeat resumes while the prompt is still up.
    await db.query("UPDATE agent_sessions SET heartbeat_at=$1,last_seen_at=$1",[at(12)]);
    await retireByPolicy(db,"sandbox",200,{ now: at(12.2) });
    const all = await starts();
    expect(all).toHaveLength(1);
    expect(all[0]!.c).toMatchObject({ alertOwner: "none",quietRestart: true,interaction: null,generation: before + 1 });
    expect((await db.query("SELECT state,reason FROM live_activity_presentation_leases")).rows)
      .toEqual([{ state: "background",reason: "restarted_still_waiting" }]);
    // Not again on the next pass.
    await retireByPolicy(db,"sandbox",200,{ now: at(12.4) });
    expect(await starts()).toHaveLength(1);
  });
});
