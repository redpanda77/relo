import { randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { createDatabase,type Database } from "../db.js";
import { ordinaryInterruptionLevel } from "../delivery-serialization.js";
import { publicId } from "../ids.js";
import { migrate } from "../migrate.js";
import { loadCurrentState } from "../current-state.js";
import { inboxActivityJoinSql,inboxActivityProjectionSql,inboxItemResource } from "../api/resources.js";
import { caller,CONTEXT,OWNER_TOKEN,resetOwner,SECRET,SESSION_A,startWork } from "./works-fixture.js";

/** The outcome notification (plan 14, 2a): one per delivered round or finished work; levels passive, passive, active, none. */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const b64 = (length: number) => randomBytes(length).toString("base64url");
const envelope = (device: string,kind = "card") => ({
  v: "relo.e2e.v1",kind,context: "acct:a/work:1",sender: "k_AAAAAAAAAAAAAAAAAAAAAA",
  recipients: [{ device,prekey: "pk_1",enc: b64(65),key: b64(48) }],nonce: b64(12),ct: b64(256 + 16),sig: b64(64),
});

suite("work outcome notification",() => {
  let db: Database,app: ReturnType<typeof createApp>,call: ReturnType<typeof caller>,deviceId: string;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET });
    call = caller(app);
  });
  afterAll(async () => db.end());
  beforeEach(async () => { ({ deviceId } = await resetOwner(db)); });

  const outcomes = async () => (await db.query(`SELECT e.id,e.title,e.body,e.payload,e.idempotency_key,
      (SELECT count(*)::int FROM delivery_jobs j WHERE j.notification_event_id=e.id) AS jobs
    FROM notification_events e WHERE e.idempotency_key LIKE 'outcome:%' ORDER BY e.created_at`)).rows;
  const finish = (result: string,outcome: unknown = { readable: "All green" },key = randomUUID(),id = "current") =>
    app.request(`/api/session/works/${id}/finish`,{ method: "POST",
      headers: { authorization: `Bearer ${OWNER_TOKEN}`,"content-type": "application/json","idempotency-key": key,
        "relo-session-key": SESSION_A,"relo-harness": "claude-code" },
      body: JSON.stringify({ result,outcome }) }).then(async (response) => ({ status: response.status,body: await response.json() as any }));

  test("deliver makes one passive notification whose body is the outcome; a retry makes no second",async () => {
    await startWork(call,{ plan: { op: "set",steps: [{ label: "Build" }] } });
    const key = randomUUID();
    const body = { outcome: { readable: "Round one shipped" } };
    const first = await app.request("/api/session/works/current/deliver",{ method: "POST",
      headers: { authorization: `Bearer ${OWNER_TOKEN}`,"content-type": "application/json","idempotency-key": key,"relo-session-key": SESSION_A },
      body: JSON.stringify(body) });
    expect(first.status).toBe(200);
    const retried = await app.request("/api/session/works/current/deliver",{ method: "POST",
      headers: { authorization: `Bearer ${OWNER_TOKEN}`,"content-type": "application/json","idempotency-key": key,"relo-session-key": SESSION_A },
      body: JSON.stringify(body) });
    expect((await retried.json() as any).replayed).toBe(true);
    // A fresh key for a round that is already closed is refused and notifies nothing.
    expect((await call("POST","/api/session/works/current/deliver",body)).status).toBe(409);
    const rows = await outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Ship works",payload: expect.objectContaining({ interruptionLevel: "passive" }),jobs: 1 });
    expect(rows[0].body).toBe("Round one shipped");
    expect(rows[0].idempotency_key).toMatch(/^outcome:[0-9a-f-]{36}:1$/);
  });

  test("the current inbox names the card an outcome reports, so a device showing that card skips the notice",async () => {
    const work = await startWork(call);
    expect((await call("POST","/api/session/works/current/deliver",{ outcome: { readable: "Round one shipped" } })).status).toBe(200);
    const [outcome] = await outcomes();
    const card = (await db.query("SELECT id FROM live_activities WHERE work_id=$1",[work.id.slice(4)])).rows[0];
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    const items = (await loadCurrentState(db,{ principalId,deviceId },{ limit: 50 })).items as any[];
    expect(items.find((item) => item.notificationId === `ntf_${outcome.id}`)).toMatchObject({ kind: "notice",outcomeOf: `act_${card.id}` });
    expect(items.filter((item) => item.outcomeOf !== undefined)).toHaveLength(1);
  });

  test("History names the card an outcome reports, so the round shows once",async () => {
    const work = await startWork(call);
    expect((await call("POST","/api/session/works/current/deliver",{ outcome: { readable: "Round one shipped" } })).status).toBe(200);
    const [outcome] = await outcomes();
    const card = (await db.query("SELECT id FROM live_activities WHERE work_id=$1",[work.id.slice(4)])).rows[0];
    const rows = (await db.query(`SELECT e.*,${inboxActivityProjectionSql},
        to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso
      FROM notification_events e ${inboxActivityJoinSql} WHERE e.id=$1 OR e.kind='live_activity'`,[outcome.id])).rows;
    const resources = rows.map((row) => inboxItemResource(row,{},undefined));
    expect(resources.find((item) => item.id === `ntf_${outcome.id}`)).toMatchObject({ outcomeOf: `act_${card.id}` });
    expect(resources.filter((item) => "outcomeOf" in item)).toHaveLength(1);
  });

  test("finish finished is passive, a finish right after the same round's delivery adds nothing",async () => {
    await startWork(call);
    await call("POST","/api/session/works/current/deliver",{ outcome: { readable: "Done for now" } });
    expect((await finish("finished")).status).toBe(200);
    const rows = await outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.interruptionLevel).toBe("passive");
  });

  test("finish failed is one active notification, and a retried finish stays one",async () => {
    const work = await startWork(call);
    const key = randomUUID();
    expect((await finish("failed",{ readable: "Tests failed" },key,work.id)).status).toBe(200);
    expect((await finish("failed",{ readable: "Tests failed" },key,work.id)).body.replayed).toBe(true);
    const rows = await outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: "Tests failed",payload: expect.objectContaining({ interruptionLevel: "active",
      workOutcome: expect.objectContaining({ result: "failed",round: 1 }) }) });
  });

  test("dropped makes none",async () => {
    await startWork(call);
    expect((await finish("dropped",{ readable: "Not needed" })).status).toBe(200);
    expect(await outcomes()).toHaveLength(0);
  });

  test("the owner's End and the admin finish make none",async () => {
    const first = await startWork(call);
    await db.query("UPDATE works SET lifecycle='paused',paused_reason='declared' WHERE id=$1",[first.id.slice(4)]);
    const admin = await call("POST",`/api/works/${first.id}/finish`,{ result: "failed",outcome: { readable: "Cleaned up" } },null);
    expect(admin.status,JSON.stringify(admin.body)).toBe(200);
    const second = await startWork(call,{},"sessionGBBBBBBBBBBBBBBBBBBBBBBB");
    await db.query("UPDATE works SET lifecycle='paused',paused_reason='declared' WHERE id=$1",[second.id.slice(4)]);
    const principalId = (await db.query("SELECT principal_id FROM works WHERE id=$1",[second.id.slice(4)])).rows[0].principal_id;
    const { endOwnerWork } = await import("./session-commands.js");
    expect("error" in await endOwnerWork(db,principalId,second.id.slice(4))).toBe(false);
    expect(await outcomes()).toHaveLength(0);
  });

  test("a notice folded during the work adds no buzz of its own",async () => {
    await startWork(call);
    const sent = await call("POST","/api/notifications",{ title: "Release",body: "Tests passed",sourceName: "Claude Code",context: CONTEXT });
    expect(sent.body).toMatchObject({ folded: true,queued: 0 });
    expect(await outcomes()).toHaveLength(0);
    expect(Number((await db.query(`SELECT count(*) FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
      WHERE e.kind='notification'`)).rows[0].count)).toBe(0);
    await finish("finished");
    expect(await outcomes()).toHaveLength(1);
  });

  test("a sealed work without a sealed outcome notifies with the placeholder, never the card's envelopes",async () => {
    const card = { alerts: [envelope(publicId("dev",deviceId))],content: envelope(publicId("dev",deviceId)) };
    await startWork(call,{ goal: { sealed: true },sealed: card });
    expect((await finish("failed",{ sealed: true })).status).toBe(200);
    const rows = await outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Encrypted notification");
    expect(rows[0].body).toBe("Open Relo on your iPhone to read this.");
    expect(rows[0].payload).toMatchObject({ privacy: "private",interruptionLevel: "active" });
    expect(rows[0].payload.sealed).toBeUndefined();
    expect(rows[0].payload.context).toBeUndefined();
  });

  test("a sealed work stores its own sealed notice (kind notice); a card-kind one is refused",async () => {
    const dev = publicId("dev",deviceId);
    const card = { alerts: [envelope(dev)],content: envelope(dev) };
    await startWork(call,{ goal: { sealed: true },sealed: card });
    const wrong = await call("POST","/api/session/works/current/deliver",{ outcome: { sealed: true },sealedOutcome: card });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toBe("invalid_sealed_content");
    const notice = { alerts: [envelope(dev,"notice")],content: envelope(dev,"notice") };
    const delivered = await call("POST","/api/session/works/current/deliver",{ outcome: { sealed: true },sealedOutcome: notice });
    expect(delivered.status,JSON.stringify(delivered.body)).toBe(200);
    const rows = await outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.sealed.content.kind).toBe("notice");
    expect(rows[0].payload.sealed.alerts[0].kind).toBe("notice");
    expect(rows[0].payload.interruptionLevel).toBe("passive");
  });

  test("a failure right after a delivery in the same round still alerts",async () => {
    await startWork(call);
    await call("POST","/api/session/works/current/deliver",{ outcome: { readable: "Shipped" } });
    expect((await finish("failed",{ readable: "Rollout broke" })).status).toBe(200);
    const rows = await outcomes();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.payload.interruptionLevel)).toEqual(["passive","active"]);
    expect(rows[1].idempotency_key).toMatch(/:1:failed$/);
  });

  test("a webhook service's finish makes its outcome notification",async () => {
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    const hook = `hook_${"S".repeat(43)}`;
    await db.query(`INSERT INTO webhook_services (principal_id,title,secret_hash,secret_prefix) VALUES ($1,'Signup bot',$2,'hook_')`,
      [principalId,hashToken(`relo:webhook:v1\n${hook}`)]);
    const send = async (method: string,path: string,body: unknown) => {
      const response = await app.request(path,{ method,headers: { authorization: `Bearer ${hook}`,"content-type": "application/json","idempotency-key": randomUUID() },
        body: JSON.stringify(body) });
      return { status: response.status,body: await response.json() as any };
    };
    const started = await send("POST","/hooks/works",{ producerKey: "signup-1",goal: "Approve signup" });
    expect(started.status).toBe(201);
    const done = await send("POST",`/hooks/works/${started.body.work.id}/finish`,{ outcome: "Approved",result: "finished" });
    expect(done.status,JSON.stringify(done.body)).toBe(200);
    const rows = await outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Approve signup",body: "Approved",payload: expect.objectContaining({ interruptionLevel: "passive" }) });
  });

  test("a private card gets the generic copy",async () => {
    const work = await startWork(call);
    await call("PATCH","/api/session/works/current",{ status: { readable: "Working" } });
    await db.query("UPDATE live_activities SET privacy='private' WHERE work_id=$1",[work.id.slice(4)]);
    await finish("finished",{ readable: "Secret result" });
    const rows = await outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).not.toContain("Secret");
    expect(rows[0].payload.privacy).toBe("private");
  });
});

describe("outcome notification levels on the wire",() => {
  const intent = (payload: Record<string,unknown>) => ({ title: "t",body: "b",notificationId: "ntf_x",payload }) as any;
  test("passive and active come from the payload; a plain notice stays active; a question stays time-sensitive",() => {
    expect(ordinaryInterruptionLevel(intent({ interruptionLevel: "passive" }),false)).toBe("passive");
    expect(ordinaryInterruptionLevel(intent({ interruptionLevel: "active" }),false)).toBe("active");
    expect(ordinaryInterruptionLevel(intent({}),false)).toBe("active");
    expect(ordinaryInterruptionLevel({ ...intent({ interruptionLevel: "passive" }),interactionKind: "approval" },false)).toBe("time-sensitive");
  });
});
