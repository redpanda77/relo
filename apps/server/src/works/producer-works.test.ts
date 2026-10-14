import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { leaseEvidence,parseLeaseSeconds } from "./lease.js";

test("lease bounds are 60..3600 whole seconds",() => {
  expect(parseLeaseSeconds(undefined)).toBeUndefined();
  expect(parseLeaseSeconds(900)).toBe(900);
  expect(parseLeaseSeconds(59)).toMatchObject({ error: "invalid_lease" });
  expect(parseLeaseSeconds(3601)).toMatchObject({ error: "invalid_lease" });
  expect(parseLeaseSeconds(90.5)).toMatchObject({ error: "invalid_lease" });
});

test("lease evidence: agent sessions have none; only an open work carries a live lease",() => {
  const until = new Date("2026-10-14T10:00:00Z");
  expect(leaseEvidence({ producer_type: "agent_session",lifecycle: "open",lease_until: null })).toBeNull();
  expect(leaseEvidence({ producer_type: "script",lifecycle: "open",lease_until: until })).toEqual({ producer: "script",leaseUntil: until.toISOString() });
  expect(leaseEvidence({ producer_type: "service",lifecycle: "finished",lease_until: until })).toEqual({ producer: "service",leaseUntil: null });
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Script and service works: producer scope, idempotency, leases",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>;
  const owner = "works_owner_abcdefghijklmnopqrstuvwxyz0123456789";
  const secret = "works-secret-with-at-least-32-characters-long";
  const hook = `hook_${"S".repeat(43)}`;
  const otherHook = `hook_${"T".repeat(43)}`;
  const P = "A".repeat(43);
  const Q = "B".repeat(43);

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    for (const [value,title] of [[hook,"Signup bot"],[otherHook,"Other bot"]] as const) {
      await db.query(`INSERT INTO webhook_services (principal_id,title,secret_hash,secret_prefix) VALUES ($1,$2,$3,'hook_')`,
        [principalId,title,hashToken(`relo:webhook:v1\n${value}`)]);
    }
  });

  async function request(method: string,path: string,body?: unknown,headers: Record<string,string> = {}) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${owner}`,"content-type": "application/json",...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  const key = () => ({ "idempotency-key": randomUUID() });

  test("script start requires Idempotency-Key and replays by it",async () => {
    expect((await request("POST",`/api/producers/${P}/works`,{ goal: "Deploy" })).body.error).toBe("idempotency_key_required");
    const first = await request("POST",`/api/producers/${P}/works`,{ goal: "Deploy",plan: { op: "set",steps: [{ label: "Build" },{ label: "Ship" }] } },{ "idempotency-key": "p-1" });
    expect(first.status).toBe(201);
    const again = await request("POST",`/api/producers/${P}/works`,{ goal: "Deploy",plan: { op: "set",steps: [{ label: "Build" },{ label: "Ship" }] } },{ "idempotency-key": "p-1" });
    expect(again.body).toMatchObject({ replayed: true,work: { id: first.body.work.id } });
  });

  test("a producer cannot see another producer's work, and scripts carry no session",async () => {
    const work = (await request("POST",`/api/producers/${P}/works`,{ goal: "Deploy" },key())).body.work;
    expect((await request("GET",`/api/producers/${Q}/works/${work.id}`)).status).toBe(404);
    expect((await request("POST",`/api/producers/${Q}/works/${work.id}/heartbeat`,{ leaseSeconds: 900 })).status).toBe(404);
    expect((await request("GET",`/api/producers/${P}/works`,undefined,{ "relo-session-key": "sessionAAAAAAAAAAAAAAAAAAAAAAAA" })).body.error).toBe("wrong_surface");
    // A script's work is invisible on the session surface.
    expect((await request("GET",`/api/session/works/${work.id}`,undefined,{ "relo-session-key": "sessionAAAAAAAAAAAAAAAAAAAAAAAA" })).status).toBe(404);
  });

  test("heartbeat moves only lease_until and declared_at; finish clears the lease",async () => {
    const work = (await request("POST",`/api/producers/${P}/works`,{ goal: "Deploy",status: "Building" },key())).body.work;
    const before = (await db.query("SELECT * FROM works")).rows[0];
    expect((await request("POST",`/api/producers/${P}/works/${work.id}/heartbeat`,{ leaseSeconds: 30 })).body.error).toBe("invalid_lease");
    const beat = await request("POST",`/api/producers/${P}/works/${work.id}/heartbeat`,{ leaseSeconds: 900 });
    expect(beat.status).toBe(200);
    const after = (await db.query("SELECT * FROM works")).rows[0];
    expect(after.lease_until.getTime() - after.declared_at.getTime()).toBeCloseTo(900_000,-3);
    for (const field of ["goal","status","plan","plan_version","lifecycle","version"]) expect(after[field]).toEqual(before[field]);
    expect(new Date(beat.body.leaseUntil).getTime()).toBe(after.lease_until.getTime());
    expect((await request("POST",`/api/producers/${P}/works/${work.id}/finish`,{ outcome: "Shipped" })).status).toBe(200);
    expect((await db.query("SELECT lease_until FROM works")).rows[0].lease_until).toBeNull();
    expect((await request("POST",`/api/producers/${P}/works/${work.id}/heartbeat`,{ leaseSeconds: 900 })).body.error).toBe("not_open");
  });

  test("the database refuses a lease on an agent-session work",async () => {
    await request("POST","/api/session/works",{ goal: { readable: "Ship" },context: { providerName: "Claude Code",project: "relo",threadName: "x" } },
      { "relo-session-key": "sessionAAAAAAAAAAAAAAAAAAAAAAAA","relo-harness": "claude-code",...key() });
    await expect(db.query("UPDATE works SET lease_until=now() WHERE producer_type='agent_session'")).rejects.toThrow(/works_lease_type/);
  });

  test("service works: secret-scoped, producerKey and Idempotency-Key required, lease on start",async () => {
    expect((await request("POST",`/hooks/${hook}/works`,{ producerKey: "signup-4711",goal: "Approve signup" })).body.error).toBe("idempotency_key_required");
    expect((await request("POST",`/hooks/${hook}/works`,{ goal: "Approve signup" },key())).body.error).toBe("invalid_producer_key");
    const started = await request("POST",`/hooks/${hook}/works`,{ producerKey: "signup-4711",goal: "Approve signup",leaseSeconds: 900 },key());
    expect(started.status).toBe(201);
    expect((await db.query("SELECT lease_until FROM works")).rows[0].lease_until).not.toBeNull();
    const id = started.body.work.id;
    expect((await request("GET",`/hooks/${otherHook}/works/${id}`)).status).toBe(404);
    expect((await request("GET",`/hooks/hook_${"Z".repeat(43)}/works/${id}`)).status).toBe(404);
    expect((await request("PATCH",`/hooks/${hook}/works/${id}`,{ status: "Checking the domain" })).body.work.status).toBe("Checking the domain");
    expect((await request("POST",`/hooks/${hook}/works/${id}/pause`)).body.work.lifecycle).toBe("paused");
    expect((await db.query("SELECT lease_until FROM works")).rows[0].lease_until).toBeNull();
    expect((await request("GET",`/hooks/${hook}/works?state=paused`)).body.works).toHaveLength(1);
  });

  test("producer reads never write",async () => {
    const work = (await request("POST",`/api/producers/${P}/works`,{ goal: "Deploy" },key())).body.work;
    const before = (await db.query("SELECT version,updated_at,declared_at FROM works")).rows[0];
    await request("GET",`/api/producers/${P}/works`); await request("GET",`/api/producers/${P}/works/${work.id}`);
    expect((await db.query("SELECT version,updated_at,declared_at FROM works")).rows[0]).toEqual(before);
  });
});
