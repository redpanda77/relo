import { createHash,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { nowSummarySchema } from "@relo/notification-contracts";
import { createApp } from "../app.js";
import { generateToken,hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("GET /api/now",() => {
  let db: Database,app: ReturnType<typeof createApp>,reader: string;
  const owner = "now_routes_owner_abcdefghijklmnopqrstuvwxyz0123";
  const S1 = createHash("sha256").update("claude-code\0one").digest("hex");

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: "now-routes-secret-with-at-least-32-characters" });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner);
    reader = generateToken();
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes) SELECT id,'reader',$1,$2 FROM owner_principals WHERE handle='owner'",
      [hashToken(reader),["inbox:read"]]);
  });

  async function request(method: string,path: string,body?: unknown) {
    const token = method === "GET" && path.startsWith("/api/now") ? reader : owner;
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      "idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any,headers: response.headers };
  }

  test("an active card is Running, a hooked session is listed, and the summary is schema-valid",async () => {
    const started = await request("POST","/api/live-activities",{ key: "build-1",acquireMode: "ensure",title: "Build",status: "Compiling" });
    expect(started.status).toBeLessThan(300);
    const hooks = (await request("POST","/api/harness-credentials",{ name: "Test Mac" })).body.token as string;
    const at = new Date().toISOString();
    const observed = await app.request("/api/agent-sessions/observed",{ method: "POST",
      headers: { authorization: `Bearer ${hooks}`,"content-type": "application/json" },
      body: JSON.stringify({ session: S1,harness: "claude-code",phase: "working",phaseSince: at,lastSeenAt: at,openToolSince: null,seq: 1 }) });
    expect(observed.status).toBe(200);
    const now = await request("GET","/api/now");
    expect(now.status).toBe(200);
    expect(now.headers.get("cache-control")).toBe("no-store");
    const summary = nowSummarySchema.parse(now.body);
    expect(summary.running.map((item) => item.title)).toEqual(["Build"]);
    expect(summary.running[0]!.owner.state).toBe("moving");
    expect(summary.lockScreen.cards).toHaveLength(1);
    expect(summary.sessions.sessions[0]).toMatchObject({ phase: "working",waitingFor: null,observed: true });
    expect(summary.refreshAt).not.toBeNull();
  });

  test("a malformed since is refused; a too-old since is clamped to T_history",async () => {
    expect((await request("GET","/api/now?since=yesterday")).status).toBe(400);
    const old = await request("GET","/api/now?since=2020-01-01T00:00:00Z");
    expect(Date.parse(old.body.serverTime) - Date.parse(old.body.sinceYouLooked.since)).toBe(8 * 3600 * 1000);
  });

  test("an ended card is in since-you-looked as done",async () => {
    await request("POST","/api/live-activities",{ key: "build-2",acquireMode: "ensure",title: "Ship",status: "Going" });
    const ended = await request("POST","/api/live-activities/build-2/end",{ status: "Shipped" });
    expect(ended.status).toBeLessThan(300);
    const summary = nowSummarySchema.parse((await request("GET","/api/now")).body);
    expect(summary.recent.map((item) => item.owner.state)).toContain("done");
    expect(summary.sinceYouLooked.finished).toBe(1);
  });

  test("a pending question on a card is Needs you, top of the Lock Screen",async () => {
    await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
      live_activity_push_to_start_token) SELECT id,$1,$2,'Phone','com.example.relo.notifications','1','1','26','sandbox',
      'authorized','authorized','fixture-alert','fixture-start' FROM owner_principals WHERE handle='owner'`,[randomUUID(),randomUUID()]);
    const started = await request("POST","/api/live-activities",{ key: "build-q",acquireMode: "ensure",title: "Release",status: "Ready" });
    const asked = await request("POST",`/api/live-activities/${started.body.activity.id}/wait`,{ type: "yes_no",prompt: "Ship?" });
    expect(asked.status).toBe(201);
    const summary = nowSummarySchema.parse((await request("GET","/api/now")).body);
    expect(summary.needsYou).toHaveLength(1);
    expect(summary.needsYou[0]).toMatchObject({ id: started.body.activity.id,owner: { state: "needs_you",needsYou: "question",lockScreen: "top" },
      question: { standing: "pending" } });
    expect(summary.lockScreen).toMatchObject({ needsYouCount: 1,focus: started.body.activity.id });
  });

  test("GET /api/now writes nothing",async () => {
    await request("POST","/api/live-activities",{ key: "build-3",acquireMode: "ensure",title: "Quiet",status: "x" });
    const before = (await db.query("SELECT id,updated_at,declared_at,state FROM live_activities ORDER BY id")).rows;
    await request("GET","/api/now");
    expect((await db.query("SELECT id,updated_at,declared_at,state FROM live_activities ORDER BY id")).rows).toEqual(before);
  });
});
