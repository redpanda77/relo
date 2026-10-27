import { createHash,randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import {
  OWNER_STATE_QUIET_SECONDS,OWNER_STATE_TIMING,agentSessionListResponseSchema,harnessCredentialCreateResponseSchema,
} from "@relo/notification-contracts";
import { deriveSessionRow } from "./derive/sessions-view.js";
import { createApp } from "./app.js";
import { loadNowSummary } from "./api/now-routes.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { SESSION_LIST_MAX,reconcileAgentSessions,recordObservedSnapshot } from "./agent-sessions.js";
import { listAgentSessions,readAgentSessions } from "./agent-session-reads.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Agent sessions: observed snapshots, read model and retention",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>,hooks: string;
  const owner = "agent_sessions_owner_abcdefghijklmnopqrstuvwxyz";
  const secret = "agent-sessions-secret-with-at-least-32-characters";
  const context = { providerName: "Claude Code",project: "relo",threadName: "Release" };
  const sessionHash = (id: string) => createHash("sha256").update(`claude-code\0${id}`).digest("hex");
  const cardKeyFor = (hash: string) => `session-claude-code-${hash.slice(0,24)}`;
  const S1 = sessionHash("one");
  const seqs = new Map<string,number>();

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    seqs.clear();
    hooks = await mintHooks();
  });

  async function request(method: string,path: string,body?: unknown,token: string | null = owner) {
    const response = await app.request(path,{
      method,headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),"content-type": "application/json",
        "idempotency-key": randomUUID() },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any,headers: response.headers };
  }
  async function mintHooks(token = owner) {
    const minted = await request("POST","/api/harness-credentials",{ name: "Test computer hooks" },token);
    expect(minted.status).toBe(201);
    return harnessCredentialCreateResponseSchema.parse(minted.body).token;
  }
  const at = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  /** One snapshot of the CLI's state machine; seq grows per session unless given. */
  function snapshot(body: Record<string,unknown>,token: string | null = hooks) {
    const session = String(body.session ?? S1);
    const seq = "seq" in body ? body.seq : (seqs.get(session) ?? 0) + 1;
    if (typeof seq === "number" && Number.isSafeInteger(seq)) seqs.set(session,Math.max(seqs.get(session) ?? 0,seq));
    const now = at();
    return request("POST","/api/agent-sessions/observed",{ session,harness: "claude-code",phase: "working",
      phaseSince: now,lastSeenAt: now,openToolSince: null,...body,seq },token);
  }
  const row = async (hash = S1) => (await db.query("SELECT * FROM agent_sessions WHERE session_hash=$1",[hash])).rows[0];
  test("context use and cost are stored, and kept when a later snapshot omits them",async () => {
    expect((await snapshot({ contextPct: 42,costUsd: 1.25 })).status).toBe(200);
    let stored = await row();
    expect(stored.context_pct).toBe(42);
    expect(Number(stored.cost_usd)).toBe(1.25);
    expect((await snapshot({ phase: "stopped" })).status).toBe(200);
    stored = await row();
    expect(stored.phase).toBe("stopped");
    expect(stored.context_pct).toBe(42);
    expect(Number(stored.cost_usd)).toBe(1.25);
    expect((await snapshot({ contextPct: 60,costUsd: 2 })).status).toBe(200);
    expect((await row()).context_pct).toBe(60);
    expect((await snapshot({ contextPct: 101 })).status).toBe(400);
  });
  test("context tokens are stored, and kept when a later snapshot omits them",async () => {
    expect((await snapshot({ contextTokens: 282_000 })).status).toBe(200);
    expect((await row()).context_tokens).toBe(282_000);
    expect((await snapshot({ phase: "stopped" })).status).toBe(200);
    expect((await row()).context_tokens).toBe(282_000);
    expect((await snapshot({ contextTokens: 300_000 })).status).toBe(200);
    expect((await row()).context_tokens).toBe(300_000);
    expect((await snapshot({ contextTokens: 10_000_001 })).status).toBe(400);
  });
  const transitions = async (hash = S1) => (await db.query(
    `SELECT t.previous_phase,t.new_phase,t.end_reason FROM agent_session_transitions t JOIN agent_sessions s ON s.id=t.session_id
     WHERE s.session_hash=$1 ORDER BY t.id`,[hash])).rows;
  test("each accepted phase change is logged once, with how the session ended; heartbeats and stale snapshots are not",async () => {
    await snapshot({ phase: "working" });
    await snapshot({ phase: "working" });
    await snapshot({ phase: "waiting" });
    await snapshot({ phase: "waiting",seq: 1 });
    await snapshot({ phase: "ended",endReason: "gone" });
    expect(await transitions()).toEqual([
      { previous_phase: null,new_phase: "working",end_reason: null },
      { previous_phase: "working",new_phase: "waiting",end_reason: null },
      { previous_phase: "waiting",new_phase: "ended",end_reason: "gone" },
    ]);
    expect((await snapshot({ phase: "ended",endReason: "bogus" })).status).toBe(400);
  });
  test("a heartbeat sets heartbeat_at, moves last_seen_at, logs no transition, and a plain snapshot of the same wait keeps heartbeat_at",async () => {
    const since = at(300);
    await snapshot({ phase: "waiting",phaseSince: since,lastSeenAt: since });
    expect((await row()).heartbeat_at).toBeNull();
    const beat = at(60);
    expect((await snapshot({ phase: "waiting",phaseSince: since,lastSeenAt: beat,heartbeat: true })).status).toBe(200);
    const stored = await row();
    expect(new Date(stored.heartbeat_at).toISOString()).toBe(beat);
    expect(new Date(stored.last_seen_at).toISOString()).toBe(beat);
    expect(new Date(stored.phase_since).toISOString()).toBe(since);
    expect(await transitions()).toEqual([{ previous_phase: null,new_phase: "waiting",end_reason: null }]);
    await snapshot({ phase: "waiting",phaseSince: since,lastSeenAt: at(30) });
    expect(new Date((await row()).heartbeat_at).toISOString()).toBe(beat);
    expect((await snapshot({ phase: "waiting",heartbeat: "yes" })).status).toBe(400);
  });
  test("each wait proves its own heartbeat: a later wait without one has none",async () => {
    await snapshot({ phase: "waiting",heartbeat: true });
    expect((await row()).heartbeat_at).not.toBeNull();
    await snapshot({ phase: "working" });
    expect((await row()).heartbeat_at).toBeNull();
    await snapshot({ phase: "waiting" });
    expect((await row()).heartbeat_at).toBeNull();
  });
  test("concurrent snapshots leave a consistent transition log",async () => {
    const at = new Date().toISOString();
    const send = (phase: "working" | "waiting" | "stopped" | "ended",seq: number) => recordObservedSnapshot(db,principalId,
      { session: S1,harness: "claude-code",phase,phaseSince: at,lastSeenAt: at,openToolSince: null,seq });
    await Promise.all([send("working",1),send("waiting",2),send("stopped",3),send("ended",4)]);
    const rows = await transitions();
    // Each row's previous phase is the prior row's new phase, whatever order the snapshots ran in.
    expect(rows.map((r) => r.previous_phase)).toEqual([null,...rows.slice(0,-1).map((r) => r.new_phase)]);
    expect(rows.at(-1)!.new_phase).toBe((await db.query("SELECT phase FROM agent_sessions WHERE session_hash=$1",[S1])).rows[0].phase);
  });
  test("transitions are pruned with the session retention",async () => {
    await snapshot({ phase: "working" });
    await snapshot({ phase: "stopped" });
    await db.query("UPDATE agent_session_transitions SET recorded_at=now()-interval '8 days' WHERE new_phase='working'");
    await reconcileAgentSessions(db);
    expect((await transitions()).map((r) => r.new_phase)).toEqual(["stopped"]);
  });
  async function keyWith(scopes: string[]) {
    const token = generateToken();
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes) VALUES ($1,$2,$3,$4)",
      [principalId,`k-${randomUUID()}`,hashToken(token),scopes]);
    return token;
  }
  async function phone() {
    return (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
      live_activity_push_to_start_token) VALUES ($1,$2,$3,'Phone','com.example.relo.notifications','1','1','26','sandbox',
      'authorized','authorized','fixture-alert','fixture-start') RETURNING id`,
    [principalId,randomUUID(),randomUUID()])).rows[0]!.id;
  }
  const startCard = async (key: string) => {
    const response = await request("POST","/api/live-activities",{ key,acquireMode: "ensure",title: "Release",status: "Working",context });
    expect(response.status).toBe(201);
    return response.body.activity.id as string;
  };
  /** Moves a session's observed times back, as if the snapshot had arrived `seconds` ago. */
  const ago = (hash: string,seconds: number) => db.query(
    `UPDATE agent_sessions SET phase_since=phase_since-make_interval(secs=>$2::double precision),
       last_seen_at=last_seen_at-make_interval(secs=>$2::double precision) WHERE session_hash=$1`,[hash,seconds]);

  describe("POST /api/agent-sessions/observed",() => {
    test("stores the snapshot and answers compactly",async () => {
      const since = at(30);
      const posted = await snapshot({ phase: "open",phaseSince: since,lastSeenAt: since,project: "relo",computer: "mac",account: "work" });
      expect(posted).toMatchObject({ status: 200,body: { ok: true } });
      expect(Object.keys(posted.body)).toEqual(["ok"]);
      const stored = await row();
      expect(stored).toMatchObject({ harness: "claude-code",project: "relo",computer: "mac",account: "work",phase: "open",
        open_tool_since: null,seq: "1" });
      expect(stored.phase_since.toISOString()).toBe(since);
      expect(stored.started_at.toISOString()).toBe(since);
      const tool = at(5);
      await snapshot({ phase: "working",phaseSince: at(10),lastSeenAt: at(2),openToolSince: tool });
      expect(await row()).toMatchObject({ phase: "working",project: "relo",seq: "2" });
      expect((await row()).open_tool_since.toISOString()).toBe(tool);
    });

    test("rejects anything outside the strict snapshot shape",async () => {
      const bad: Record<string,unknown>[] = [
        { session: "short" },
        { session: `${"a".repeat(129)}` },
        { session: "has spaces in it 123456" },
        { phase: "tool" },
        { phase: "prompt" },
        { phase: "lost" },
        { harness: "Claude Code" },
        { harness: "a".repeat(41) },
        { project: "x".repeat(121) },
        { computer: "x".repeat(121) },
        { account: "x".repeat(41) },
        { project: "line\nbreak" },
        { phaseSince: "yesterday" },
        { openToolSince: undefined },
        { seq: 0 },
        { seq: -1 },
        { seq: 2.5 },
        { seq: "3" },
        { event: "prompt" },
        { prompt: "free text" },
        { tool: "Bash" },
        { transcript: "/tmp/x" },
      ];
      for (const body of bad) {
        const response = await snapshot(body);
        expect(response.status,JSON.stringify(body)).toBe(400);
        expect(response.body.error).toBe("invalid_request");
      }
      expect((await request("POST","/api/agent-sessions/observed","{not json",hooks)).status).toBe(400);
      expect((await db.query("SELECT count(*)::int AS n FROM agent_sessions")).rows[0].n).toBe(0);
    });

    test("accepts a base64url session hash",async () => {
      const hash = createHash("sha256").update("x").digest("base64url");
      expect((await snapshot({ session: hash })).status).toBe(200);
    });

    test("only a harness credential posts snapshots: CLI keys of any scope, phones and strangers are refused",async () => {
      expect((await snapshot({},null)).status).toBe(401);
      expect((await snapshot({},"relo_not-a-real-token-at-all-aaaaaaaaaaaaaaaaaaa")).status).toBe(401);
      for (const token of [owner,await keyWith(["activities:write"]),await keyWith(["services:write","activities:read"])]) {
        expect(await snapshot({},token)).toMatchObject({ status: 403,body: { error: "harness_credential_required" } });
      }
      const device = await phone();
      const credential = generateToken();
      await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read','activities:write'])",
        [device,hashToken(credential)]);
      expect((await snapshot({},credential)).status).toBe(403);
      expect((await db.query("SELECT count(*)::int AS n FROM agent_sessions")).rows[0].n).toBe(0);
      expect((await snapshot({})).status).toBe(200);
      // The scope is gone: no key carries it, new keys included.
      expect((await db.query("SELECT count(*)::int AS n FROM principal_api_keys WHERE 'sessions:write'=ANY(scopes)")).rows[0].n).toBe(0);
    });

    test("reading the list needs an owner credential with activities:read; never the harness credential",async () => {
      await snapshot({});
      expect((await request("GET","/api/agent-sessions",undefined,await keyWith(["notifications:send"]))).status).toBe(403);
      expect((await request("GET","/api/agent-sessions",undefined,null)).status).toBe(401);
      expect(await request("GET","/api/agent-sessions",undefined,hooks))
        .toMatchObject({ status: 403,body: { error: "harness_credential_not_allowed" } });
      const read = await request("GET","/api/agent-sessions",undefined,await keyWith(["activities:read"]));
      expect(read.status).toBe(200);
      expect(agentSessionListResponseSchema.parse(read.body).sessions).toHaveLength(1);
    });

    test("is rate limited per harness credential",async () => {
      // The limit counts per clock minute: a burst that straddles a minute boundary starts a fresh window, so
      // it is sent again (once) rather than reading a slow machine as a missing limit.
      let last = 200;
      for (let attempt = 0; attempt < 2 && last === 200; attempt += 1) {
        const minute = Math.floor(Date.now() / 60_000);
        for (let i = 0; i < 121 && last === 200; i += 1) last = (await snapshot({})).status;
        if (Math.floor(Date.now() / 60_000) === minute) break;
      }
      expect(last).toBe(429);
      const limited = await snapshot({});
      expect(limited.body).toMatchObject({ error: "rate_limited",scope: "client" });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      // Another harness credential of the account still writes.
      expect((await snapshot({},await mintHooks())).status).toBe(200);
    });

    test("ordered by seq: a repeat or an older snapshot never overwrites a newer one",async () => {
      await snapshot({ phase: "working",phaseSince: at(300),lastSeenAt: at(60),seq: 5 });
      const newer = await row();
      for (let i = 0; i < 3; i += 1) {
        expect((await snapshot({ phase: "working",phaseSince: at(300),lastSeenAt: at(60),seq: 5 })).body).toEqual({ ok: true });
      }
      // A late snapshot from before (lower seq) with a later-looking clock still changes nothing.
      expect((await snapshot({ phase: "stopped",phaseSince: at(1),lastSeenAt: at(1),seq: 4,project: "late" })).status).toBe(200);
      expect((await snapshot({ phase: "ended",phaseSince: at(1),lastSeenAt: at(1),seq: 1 })).status).toBe(200);
      expect(await row()).toEqual(newer);
      expect(await db.query("SELECT 1 FROM agent_sessions")).toHaveProperty("rowCount",1);
      // A newer one applies.
      await snapshot({ phase: "stopped",phaseSince: at(1),lastSeenAt: at(1),seq: 6 });
      expect(await row()).toMatchObject({ phase: "stopped",seq: "6" });
    });

    test("the CLI decides the phase: an ended session reported working again is working",async () => {
      const first = at(600);
      await snapshot({ phase: "open",phaseSince: first,lastSeenAt: first });
      await snapshot({ phase: "ended",phaseSince: at(300),lastSeenAt: at(300) });
      await snapshot({ phase: "working",phaseSince: at(10),lastSeenAt: at(10) });
      expect(await row()).toMatchObject({ phase: "working" });
      expect((await row()).started_at.toISOString()).toBe(first);
    });

    test("future times are clamped to the server clock; last seen is never before the phase began",async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      await snapshot({ phaseSince: future,lastSeenAt: future,openToolSince: future });
      const seconds = (await db.query(`SELECT extract(epoch FROM phase_since-now()) AS a,extract(epoch FROM last_seen_at-now()) AS b,
        extract(epoch FROM open_tool_since-now()) AS c FROM agent_sessions`)).rows[0];
      for (const value of Object.values(seconds)) expect(Number(value)).toBeLessThan(310);
      await snapshot({ phaseSince: at(10),lastSeenAt: at(60) });
      const stored = await row();
      expect(stored.last_seen_at.valueOf()).toBe(stored.phase_since.valueOf());
    });

    test("no per-event storage: one row per session, whatever the number of snapshots",async () => {
      for (const phase of ["open","working","waiting","working","stopped","working","stopped","ended"]) {
        expect((await snapshot({ phase })).status).toBe(200);
      }
      expect((await db.query("SELECT count(*)::int AS n FROM agent_sessions")).rows[0].n).toBe(1);
      const columns = (await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name='agent_sessions'")).rows.map((column) => column.column_name);
      // The snapshot and its labels, nothing per event.
      expect(columns.sort()).toEqual(["account","computer","context_pct","context_tokens","cost_usd","created_at","harness","heartbeat_at","id","last_seen_at","open_tool_since","phase",
        "phase_since","principal_id","project","sealed_names","seq","session_hash","started_at","title","updated_at"]);
      const tables = (await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_name ~ '(session|hook).*event'")).rows;
      expect(tables).toEqual([]);
    });
  });

  describe("harness credentials",() => {
    test("an owner credential with services:write mints, lists and revokes; the token is hashed at rest",async () => {
      const minted = await request("POST","/api/harness-credentials",{ name: "Second computer" });
      expect(minted.status).toBe(201);
      const { id,token } = harnessCredentialCreateResponseSchema.parse(minted.body);
      const stored = (await db.query("SELECT * FROM harness_credentials WHERE id=$1",[id.slice(4)])).rows[0];
      expect(stored.token_hash).not.toContain(token);
      expect(JSON.stringify(stored)).not.toContain(token);
      const listed = await request("GET","/api/harness-credentials");
      expect(listed.body.credentials.map((credential: any) => credential.name)).toContain("Second computer");
      expect(JSON.stringify(listed.body)).not.toContain(token);
      expect((await snapshot({},token)).status).toBe(200);
      expect(await request("DELETE",`/api/harness-credentials/${id}`)).toMatchObject({ status: 200,body: { revoked: true } });
      expect(await snapshot({},token)).toMatchObject({ status: 401,body: { error: "credential_revoked" } });
      expect((await request("DELETE","/api/harness-credentials/hck_00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });

    test("minting needs an owner credential with services:write; a harness credential cannot mint or revoke",async () => {
      expect((await request("POST","/api/harness-credentials",{ name: "x" },await keyWith(["activities:write"]))).status).toBe(403);
      expect(await request("POST","/api/harness-credentials",{ name: "x" },hooks))
        .toMatchObject({ status: 403,body: { error: "harness_credential_not_allowed" } });
      expect((await request("POST","/api/harness-credentials",{ name: "" })).status).toBe(400);
      expect((await request("POST","/api/harness-credentials",{ name: "x",scopes: ["activities:write"] })).status).toBe(400);
      const { id } = (await request("GET","/api/harness-credentials")).body.credentials[0];
      expect((await request("DELETE",`/api/harness-credentials/${id}`,undefined,hooks)).status).toBe(403);
    });
  });

  describe("retention: prunes only; phases are derived, never stored",() => {
    test("reconcileAgentSessions changes no row it does not delete; old sessions go after the retention period",async () => {
      await snapshot({ phase: "working" });
      await ago(S1,9 * 3600);
      const before = await row();
      expect(await reconcileAgentSessions(db)).toEqual({ pruned: 0 });
      expect(await row()).toEqual(before);
      await ago(S1,8 * 24 * 3600);
      expect(await reconcileAgentSessions(db)).toEqual({ pruned: 1 });
      expect(await row()).toBeUndefined();
    });

    test("a phase change wakes the current-state stream; a heartbeat does not",async () => {
      const client = await db.connect();
      const hints: string[] = [];
      client.on("notification",message => { if (message.channel === "relo_current_changes") hints.push(message.payload ?? ""); });
      try {
        await client.query("LISTEN relo_current_changes");
        await snapshot({ phase: "open" });
        await snapshot({ phase: "working",phaseSince: at(),lastSeenAt: at() });
        await snapshot({ phase: "working",lastSeenAt: at() });
        await snapshot({ phase: "stopped" });
        await new Promise(resolve => setTimeout(resolve,200));
        expect(hints.map(hint => JSON.parse(hint))).toEqual([
          { principalId,subjectId: null },{ principalId,subjectId: null },{ principalId,subjectId: null },
        ]);
      } finally {
        await client.query("UNLISTEN relo_current_changes");
        client.release();
      }
    });
  });

  describe("phases: working, waiting, idle, ended",() => {
    const listed = async (hash = S1) => {
      const id = `ags_${(await row(hash)).id}`;
      return (await listAgentSessions(db,principalId)).find(session => session.id === id);
    };

    test("working, unseen for T_fresh/2 idle; stopped waits T_fresh (your turn); a prompt waits T_history (input)",async () => {
      await snapshot({ phase: "working" });
      expect(await listed()).toMatchObject({ phase: "working",waitingFor: null });
      await ago(S1,OWNER_STATE_QUIET_SECONDS + 5);
      expect((await listed())?.phase).toBe("idle");
      await snapshot({ phase: "stopped" });
      expect(await listed()).toMatchObject({ phase: "waiting",waitingFor: "turn" });
      await ago(S1,OWNER_STATE_TIMING.freshSeconds + 5);
      expect(await listed()).toMatchObject({ phase: "idle",waitingFor: null });
      await snapshot({ phase: "waiting" });
      await ago(S1,OWNER_STATE_TIMING.historySeconds - 60);
      expect(await listed()).toMatchObject({ phase: "waiting",waitingFor: "input" });
      await ago(S1,120);
      expect((await listed())?.phase).toBe("idle");
    });

    test("a heartbeat keeps a long turn working",async () => {
      await snapshot({ phase: "working",phaseSince: at(3600),lastSeenAt: at(3600) });
      expect((await listed())?.phase).toBe("idle");
      await snapshot({ phase: "working",phaseSince: at(3600),lastSeenAt: at(30) });
      expect((await listed())?.phase).toBe("working");
    });

    test("?phase= lists only those phases, live first; counts cover every phase; a bad phase is a 400",async () => {
      const [working,waiting,idle,ended] = ["w","x","i","e"].map(sessionHash);
      await snapshot({ session: working,phase: "working" });
      await snapshot({ session: waiting,phase: "stopped" });
      await snapshot({ session: idle,phase: "stopped" }); await ago(idle,OWNER_STATE_TIMING.freshSeconds + 5);
      await snapshot({ session: ended,phase: "ended" });
      const all = await request("GET","/api/agent-sessions");
      expect(all.body.sessions.map((session: any) => session.phase)).toEqual(["working","waiting","idle"]); // ended ones are gone
      expect((await request("GET","/api/agent-sessions?phase=ended")).body.sessions.map((session: any) => session.phase)).toEqual(["ended"]);
      const live = await request("GET","/api/agent-sessions?phase=working,waiting");
      expect(live.status).toBe(200);
      expect(agentSessionListResponseSchema.parse(live.body).sessions.map(session => session.phase)).toEqual(["working","waiting"]);
      expect(live.body.counts).toEqual({ working: 1,waiting: 1,idle: 1,ended: 1 });
      expect((await request("GET","/api/agent-sessions?phase=asleep")).status).toBe(400);
    });

    test("the listing's phases equal deriveSessionRow for every row",async () => {
      for (const [hash,phase,seconds] of [
        [sessionHash("a"),"working",0],[sessionHash("b"),"stopped",60],[sessionHash("c"),"stopped",OWNER_STATE_TIMING.freshSeconds + 60],
        [sessionHash("d"),"waiting",600],[sessionHash("e"),"open",0],[sessionHash("f"),"ended",0],
      ] as const) {
        await snapshot({ session: hash,phase });
        await ago(hash,seconds);
      }
      const now = new Date();
      const rows = (await db.query("SELECT * FROM agent_sessions")).rows;
      for (const session of await listAgentSessions(db,principalId)) {
        const stored = rows.find((candidate) => `ags_${candidate.id}` === session.id);
        const derived = deriveSessionRow({ now: now.toISOString(),observed: { phase: stored.phase,
          phaseSince: stored.phase_since.toISOString(),lastSeenAt: stored.last_seen_at.toISOString() },lastDeclaredAt: null });
        expect([derived.phase,derived.waitingFor]).toEqual([session.phase,session.waitingFor]);
      }
    });
  });

  describe("read model and exposure",() => {
    test("lists the last 24 hours, at most 20, live sessions first, a quiet session reading as idle",async () => {
      for (let i = 0; i < SESSION_LIST_MAX + 4; i += 1) {
        await snapshot({ session: sessionHash(`many-${i}`),phase: "working",computer: `mac-${i}` });
      }
      await snapshot({ session: sessionHash("old"),phase: "open" });
      await ago(sessionHash("old"),25 * 3600);
      await snapshot({ session: sessionHash("ended"),phase: "open" }); await snapshot({ session: sessionHash("ended"),phase: "ended" });
      await ago(sessionHash("many-0"),OWNER_STATE_QUIET_SECONDS + 30);
      const read = await readAgentSessions(db,principalId);
      const sessions = read.sessions;
      expect(sessions).toHaveLength(SESSION_LIST_MAX);
      expect(sessions.some(session => session.computer === "mac-0")).toBe(false);
      expect(agentSessionListResponseSchema.parse(read).sessions).toHaveLength(SESSION_LIST_MAX);
      expect(read.counts).toEqual({ working: SESSION_LIST_MAX + 3,waiting: 0,idle: 1,ended: 1 });
      await db.query("DELETE FROM agent_sessions WHERE session_hash NOT IN ($1,$2)",[sessionHash("many-0"),sessionHash("ended")]);
      expect((await listAgentSessions(db,principalId)).map(session => session.phase)).toEqual(["idle"]);
      expect((await listAgentSessions(db,principalId,{ phases: ["ended"] })).map(session => session.phase)).toEqual(["ended"]);
    });

    test("has the documented JSON shape",async () => {
      await phone();
      const key = cardKeyFor(S1);
      const id = await startCard(key);
      await db.query("UPDATE live_activities SET producer_type='agent_session',session_key=$2 WHERE id=$1",[id.slice(4),S1]);
      await snapshot({ phase: "open",project: "relo",computer: "mac",account: "work" });
      await snapshot({ phase: "working" });
      const { body } = await request("GET","/api/agent-sessions");
      expect(body.sessions).toHaveLength(1);
      expect(body.counts).toEqual({ working: 1,waiting: 0,idle: 0,ended: 0 });
      expect(body.sessions[0]).toEqual({
        id: expect.stringMatching(/^ags_[0-9a-f-]{36}$/),harness: "claude-code",computer: "mac",account: "work",project: "relo",
        phase: "working",waitingFor: null,startedAt: expect.any(String),lastSeenAt: expect.any(String),
        card: { id,state: "active" },
      });
    });

    test("the inbox snapshot a phone reads carries no sessions; Now is the one sessions view",async () => {
      const device = await phone();
      const credential = generateToken();
      await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read'])",[device,hashToken(credential)]);
      await snapshot({ phase: "working",computer: "mac" });
      await snapshot({ session: sessionHash("never-prompted"),phase: "open",computer: "mac" });
      const inbox = (await request("GET","/api/inbox/snapshot",undefined,credential)).body;
      expect(inbox.sessions).toBeUndefined();
      const now = await loadNowSummary(db,principalId,device,undefined);
      // A session that started and never prompted is not in Sessions until its first prompt.
      expect(now.sessions.sessions).toHaveLength(1);
      expect(now.sessions.sessions[0]).toMatchObject({ computer: "mac",phase: "working" });
    });

    test("sealed session names reach the phone's Now only, as stored",async () => {
      const bytes = (n: number) => randomBytes(n).toString("base64url");
      const names = { v: "relo.e2e.v1",kind: "names",context: "ses:abc",sender: `k_${bytes(16)}`,
        recipients: [{ device: "dev_1",prekey: "pk_1",enc: bytes(65),key: bytes(48) }],nonce: bytes(12),ct: bytes(272),sig: bytes(64) };
      expect((await snapshot({ phase: "open",project: "p-aaaaaaaaaaaaaaaa",sealedNames: { ...names,kind: "notice" } })).status).toBe(400);
      expect((await snapshot({ phase: "open",project: "p-aaaaaaaaaaaaaaaa",sealedNames: { ...names,ct: "short" } })).status).toBe(400);
      expect((await snapshot({ phase: "open",project: "p-aaaaaaaaaaaaaaaa",sealedNames: names })).status).toBe(200);
      expect((await snapshot({ phase: "working" })).status).toBe(200);
      const device = await phone();
      const credential = generateToken();
      await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read'])",[device,hashToken(credential)]);
      const now = await loadNowSummary(db,principalId,device,undefined);
      expect(now.sessions.sessions[0]!.sealedNames).toEqual(names);
      expect((await loadNowSummary(db,principalId,undefined,undefined)).sessions.sessions[0]!.sealedNames).toBeUndefined();
      const read = await request("GET","/api/agent-sessions");
      expect(read.body.sessions[0].sealedNames).toBeUndefined();
    });

    test("a readable session title is stored, kept by a later snapshot without one, and returned on the row and its card",async () => {
      expect((await snapshot({ phase: "working",title: "Fix the login bug" })).status).toBe(200);
      expect((await snapshot({ phase: "working",title: "bad\ntitle" })).status).toBe(400);
      expect((await snapshot({ phase: "working" })).status).toBe(200);
      expect((await db.query("SELECT title FROM agent_sessions WHERE session_hash=$1",[S1])).rows[0].title).toBe("Fix the login bug");
      const now = await loadNowSummary(db,principalId,undefined,undefined);
      expect(now.sessions.sessions[0]!.title).toBe("Fix the login bug");
      expect((await snapshot({ phase: "working",title: "Renamed" })).status).toBe(200);
      expect((await loadNowSummary(db,principalId,undefined,undefined)).sessions.sessions[0]!.title).toBe("Renamed");
    });

    test("another account never sees the sessions",async () => {
      await snapshot({ phase: "open",computer: "mac-private" });
      const other = (await db.query("INSERT INTO owner_principals(handle) VALUES ('other2') RETURNING id")).rows[0].id;
      const token = generateToken();
      await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash) VALUES ($1,'k',$2)",[other,hashToken(token)]);
      const read = await request("GET","/api/agent-sessions",undefined,token);
      expect(read.body).toEqual({ sessions: [],counts: { working: 0,waiting: 0,idle: 0,ended: 0 } });
      // The same hash on another account is its own session.
      expect((await snapshot({ phase: "open",harness: "codex",seq: 1 },await mintHooks(token))).status).toBe(200);
      expect((await db.query("SELECT count(*)::int AS n FROM agent_sessions")).rows[0].n).toBe(2);
    });
  });
});
