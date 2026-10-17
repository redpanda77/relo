import { randomUUID } from "node:crypto";
import { readFileSync,readdirSync,statSync } from "node:fs";
import { join,relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";

/**
 * ADR 0008 (the CLI is the edge; plan EDGE.2, EDGE.5, HA.1). The server is clock, aggregator,
 * deliverer and authority: it stores the CLI's observed phase snapshots and interprets them only in
 * derive(). These tests fail if raw harness activity, or a second place that reads meaning into
 * observed state, comes back, or if the credential split between observed and declared writes leaks.
 */
const SRC = fileURLToPath(new URL(".",import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function* sources(dir = SRC): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir,name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.ts$/.test(name) && path !== SELF) yield path;
  }
}
const scan = (pattern: RegExp,allowed: (file: string) => boolean = () => false) => {
  const found: string[] = [];
  for (const file of sources()) {
    const rel = relative(SRC,file);
    if (allowed(rel)) continue;
    readFileSync(file,"utf8").split("\n").forEach((line,index) => {
      if (pattern.test(line)) found.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
};

describe("EDGE.5: the server never interprets raw harness activity",() => {
  test("no raw hook event names, event streams or last-event fields anywhere in the server",() => {
    expect(scan(new RegExp(`(?<![A-Za-z])(${[
      "UserPromptSubmit","PostToolUse","PreToolUse","SessionStart","SessionEnd","SubagentStart","SubagentStop",
      "PermissionRequest","hook_event_name","tool_use_id","last_event","lastEvent","agent-sessions/events",
      "AGENT_SESSION_EVENTS","OBSERVED_SESSION_EVENTS","agentSessionPhase\\(",
    ].join("|")})`))).toEqual([]);
  });

  test("observed evidence is read only by its storage module and derive(): no phase rules elsewhere",() => {
    const evidence = /\b(phase_since|open_tool_since|phaseSince|openToolSince)\b/;
    const owners = (file: string) => file.startsWith("derive/") || file === "agent-sessions.ts" || file.endsWith(".test.ts")
      || file === "api/agent-session-routes.ts"
      // Read-only measures over the transition log; they write and derive nothing.
      || file === "agent-session-metrics.ts"
      // The docs site documents the HTTP fields as text; it reads no state.
      || file === "web/docs/site.generated.ts";
    expect(scan(evidence,owners)).toEqual([]);
  });

  test("the transition metrics are read-only and nothing that derives or writes a card or work imports them",() => {
    const metrics = readFileSync(join(SRC,"agent-session-metrics.ts"),"utf8");
    expect(metrics).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    const importers = [...sources()].map((file) => relative(SRC,file)).filter((file) => !file.endsWith(".test.ts")
      && (file.startsWith("derive/") || file.startsWith("works/") || /card/i.test(file))
      && /agent-session-metrics/.test(readFileSync(join(SRC,file),"utf8")));
    expect(importers).toEqual([]);
  });

  test("the storage module derives no freshness of its own: sessions are shown as derive() reports them",() => {
    const text = readFileSync(join(SRC,"agent-sessions.ts"),"utf8");
    expect(text).not.toMatch(/freshSeconds|OWNER_STATE_TIMING|quietFor|presence/);
  });

  test("the storage module stores snapshots as reported: no comparison on a stored phase",() => {
    const text = readFileSync(join(SRC,"agent-sessions.ts"),"utf8");
    expect(text).not.toMatch(/\brow\.phase\s*[!=]==?/);
    expect(text).not.toMatch(/\bphase\s*(<>|!=|=\s*'|IN\s*\()/i);
    expect(text).not.toMatch(/\bphase_since\s*[<>]/);
  });
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("HA.1: observed and declared writes use separate credentials",() => {
  let db: Database,app: ReturnType<typeof createApp>,hooks: string;
  const owner = "edge_invariants_owner_abcdefghijklmnopqrstuvwxyz";

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: "edge-invariants-secret-with-32-characters" });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner);
    hooks = (await request(owner,"POST","/api/harness-credentials",{ name: "Test computer hooks" })).body.token;
  });

  async function request(token: string,method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      "idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }

  test("a harness credential is refused by every route but the observed one, before any route runs",async () => {
    const declared: [string,string,unknown?][] = [
      ["POST","/api/session/works",{ goal: { readable: "Ship" } }],
      ["PATCH","/api/session/works/wrk_00000000-0000-4000-8000-000000000000",{ status: { readable: "x" } }],
      ["POST","/api/live-activities",{ key: "k",acquireMode: "ensure",title: "T",status: "S" }],
      ["PATCH","/api/live-activities/act_00000000-0000-4000-8000-000000000000",{ status: "x" }],
      ["POST","/api/interactions",{ title: "Deploy?",prompt: "Deploy?",type: "approval" }],
      ["POST","/api/notifications",{ title: "Hi",body: "There" }],
      ["GET","/api/agent-sessions"],
      ["GET","/api/now"],
      ["GET","/api/inbox/snapshot"],
      ["GET","/api/clients/self"],
      ["POST","/api/harness-credentials",{ name: "more" }],
      ["GET","/api/agent-sessions/observed"],
    ];
    for (const [method,path,body] of declared) {
      expect(await request(hooks,method,path,body),`${method} ${path}`)
        .toMatchObject({ status: 403,body: { error: "harness_credential_not_allowed" } });
    }
    for (const table of ["works","live_activities","interaction_requests","notification_events"]) {
      expect((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,table).toBe(0);
    }
  });

  test("a principal credential cannot post observed state",async () => {
    const at = new Date().toISOString();
    expect(await request(owner,"POST","/api/agent-sessions/observed",{ session: "a".repeat(64),harness: "claude-code",
      phase: "working",phaseSince: at,lastSeenAt: at,openToolSince: null,seq: 1 }))
      .toMatchObject({ status: 403,body: { error: "harness_credential_required" } });
    expect((await db.query("SELECT count(*)::int AS n FROM agent_sessions")).rows[0].n).toBe(0);
  });
});
