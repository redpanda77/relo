import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { setEndToEndRequired } from "../end-to-end-policy.js";
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
  /** A service route reads its secret only from this header. */
  const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

  test("script start requires Idempotency-Key and replays by it",async () => {
    expect((await request("POST",`/api/producers/${P}/works`,{ goal: "Deploy" })).body.error).toBe("idempotency_key_required");
    const first = await request("POST",`/api/producers/${P}/works`,{ goal: "Deploy",plan: { op: "set",steps: [{ label: "Build" },{ label: "Ship" }] } },{ "idempotency-key": "p-1" });
    expect(first.status).toBe(201);
    const again = await request("POST",`/api/producers/${P}/works`,{ goal: "Deploy",plan: { op: "set",steps: [{ label: "Build" },{ label: "Ship" }] } },{ "idempotency-key": "p-1" });
    expect(again.body).toMatchObject({ replayed: true,work: { id: first.body.work.id } });
  });

  test("script update applies every plan command: revise keeps done steps, next, add, step",async () => {
    const work = (await request("POST",`/api/producers/${P}/works`,{ goal: "Deploy",plan: { op: "set",steps: [{ label: "Build" },{ label: "Ship" }] } },key())).body.work;
    const path = `/api/producers/${P}/works/${work.id}`;
    expect((await request("PATCH",path,{ plan: { op: "next" } })).status).toBe(200);
    const revised = await request("PATCH",path,{ plan: { op: "revise",labels: ["Ship","Verify"] } });
    expect(revised.body.work.plan.steps.map((step: { label: string; state: string }) => [step.label,step.state]))
      .toEqual([["Build","done"],["Ship","current"],["Verify","open"]]);
    const added = await request("PATCH",path,{ plan: { op: "add",steps: [{ label: "Announce" }] } });
    const announce = added.body.work.plan.steps.find((step: { label: string }) => step.label === "Announce");
    expect((await request("PATCH",path,{ plan: { op: "step",id: announce.id } })).body.work.plan.steps.find((step: { id: string }) => step.id === announce.id).state).toBe("current");
    expect((await request("PATCH",path,{ plan: { op: "bogus" } })).body.error).toBe("invalid_request");
  });

  test("a script's sealed work stores no text, takes no readable text, and readable script text waits for end-to-end",async () => {
    const card = { v: 1,kind: "card" };
    const sealed = (await request("POST",`/api/producers/${P}/works`,{ goal: { sealed: true },plan: { op: "set",steps: [{ id: "s1" },{ id: "s2" }] },
      sealed: card,producerSealed: { v: 1 } },key())).body.work;
    const row = (await db.query("SELECT sealed_text,goal,status,plan FROM works WHERE producer_key=$1",[P])).rows[0];
    expect(row).toMatchObject({ sealed_text: true,goal: null,status: null });
    expect(row.plan.steps.every((step: { label?: string }) => step.label === undefined)).toBe(true);
    const path = `/api/producers/${P}/works/${sealed.id}`;
    expect((await request("PATCH",path,{ status: "Shipping" })).body.error).toBe("invalid_request");
    expect((await request("PATCH",path,{ status: { sealed: true },plan: { op: "next" },sealed: card })).status).toBe(200);
    expect((await request("POST",`${path}/finish`,{ outcome: { sealed: true },sealed: card })).body.work.lifecycle).toBe("finished");
    // On an account that requires end-to-end encryption, readable script text is refused before any write; a service
    // (which cannot seal) posts readable text only with the owner's leave for it (plan 10 A3).
    await setEndToEndRequired(db,principalId,true);
    expect((await request("POST",`/api/producers/${Q}/works`,{ goal: "Deploy" },key()))).toMatchObject({ status: 409,body: { error: "end_to_end_required" } });
    expect((await request("POST",`/api/producers/${Q}/works`,{ goal: { readable: "Deploy" } },key())).status).toBe(409);
    expect((await request("POST","/hooks/works",{ goal: "Signup",producerKey: "signup-1" },{ ...key(),...bearer(hook) })).status).toBe(409);
    await db.query("UPDATE webhook_services SET readable_allowed=true WHERE principal_id=$1",[principalId]);
    expect((await request("POST","/hooks/works",{ goal: "Signup",producerKey: "signup-1" },{ ...key(),...bearer(hook) })).status).toBe(201);
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
    expect((await request("POST","/hooks/works",{ producerKey: "signup-4711",goal: "Approve signup" },bearer(hook))).body.error).toBe("idempotency_key_required");
    expect((await request("POST","/hooks/works",{ goal: "Approve signup" },{ ...key(),...bearer(hook) })).body.error).toBe("invalid_producer_key");
    const started = await request("POST","/hooks/works",{ producerKey: "signup-4711",goal: "Approve signup",leaseSeconds: 900 },{ ...key(),...bearer(hook) });
    expect(started.status).toBe(201);
    expect((await db.query("SELECT lease_until FROM works")).rows[0].lease_until).not.toBeNull();
    const id = started.body.work.id;
    expect((await request("GET",`/hooks/works/${id}`,undefined,bearer(otherHook))).status).toBe(404);
    expect((await request("GET",`/hooks/works/${id}`,undefined,bearer(`hook_${"Z".repeat(43)}`))).status).toBe(404);
    expect((await request("PATCH",`/hooks/works/${id}`,{ status: "Checking the domain" },bearer(hook))).body.work.status).toBe("Checking the domain");
    expect((await request("POST",`/hooks/works/${id}/pause`,undefined,bearer(hook))).body.work.lifecycle).toBe("paused");
    expect((await db.query("SELECT lease_until FROM works")).rows[0].lease_until).toBeNull();
    expect((await request("GET","/hooks/works?state=paused",undefined,bearer(hook))).body.works).toHaveLength(1);
  });

  test("a script's and a service's work project their card the same way: start, steps advance, end",async () => {
    await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
      live_activity_push_to_start_token) VALUES ($1,$2,$3,'Phone','com.example.relo.notifications','1','1','26','sandbox',
      'authorized','authorized','fixture-alert','fixture-start')`,[principalId,randomUUID(),randomUUID()]);
    const producers = [
      { name: "script",base: `/api/producers/${P}/works`,start: {},auth: {},source: "bootstrap-owner" },
      { name: "service",base: "/hooks/works",start: { producerKey: "nightly-backup" },auth: bearer(hook),source: "Signup bot" },
    ];
    for (const producer of producers) {
      const started = await request("POST",producer.base,{ ...producer.start,goal: `Nightly backup by ${producer.name}`,
        context: { project: "Backups" },plan: { op: "set",steps: [{ label: "Dump" },{ label: "Upload" }] } },{ ...key(),...producer.auth });
      expect(started.status,producer.name).toBe(201);
      const id = started.body.work.id as string;
      const card = async () => (await db.query("SELECT * FROM live_activities WHERE work_id=$1",[id.slice(4)])).rows[0];
      /** Which step the card shows as current (1-based). */
      const steps = (row: any) => {
        const items = ((row.presentation?.components ?? []).find((component: any) => component.type === "steps")?.items ?? []) as Array<{ state: string }>;
        return { current: items.findIndex((item) => item.state === "current") + 1 };
      };
      expect(await card(),producer.name).toMatchObject({ state: "active",title: `Nightly backup by ${producer.name}` });
      expect(steps(await card())?.current,producer.name).toBe(1);
      await request("PATCH",`${producer.base}/${id}`,{ status: "Uploading",plan: { op: "next" } },producer.auth);
      expect(await card(),producer.name).toMatchObject({ status: "Uploading" });
      expect(steps(await card())?.current,producer.name).toBe(2);
      await request("POST",`${producer.base}/${id}/finish`,{ result: "finished",outcome: "Backed up" },producer.auth);
      expect(await card(),producer.name).toMatchObject({ state: "ended",status: "Backed up" });
    }
  });

  test("producer reads never write",async () => {
    const work = (await request("POST",`/api/producers/${P}/works`,{ goal: "Deploy" },key())).body.work;
    const before = (await db.query("SELECT version,updated_at,declared_at FROM works")).rows[0];
    await request("GET",`/api/producers/${P}/works`); await request("GET",`/api/producers/${P}/works/${work.id}`);
    expect((await db.query("SELECT version,updated_at,declared_at FROM works")).rows[0]).toEqual(before);
  });
});
