import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { agentSessionRowsSql } from "./agent-sessions.js";
import { sessionsViewRows } from "./derive/sessions-view.js";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { loadOwnerStateInputs } from "./derive/load.js";
import { deriveOwnerState } from "./derive/owner-state.js";
import { migrate } from "./migrate.js";
// The CLI's own caller detection: the observed snapshots and the CLI's work meet by this key only.
// @ts-ignore untyped CLI module
import { detectCaller } from "../../../packages/cli/src/caller.mjs";
import { sessionKey } from "../../../packages/cli/src/shared/session-key.mjs";

/**
 * Observed state scenarios, STATE-SPEC 2.2, 4.3, 4.4, 6.1 and 9, at the server's edge (ADR 0008):
 * the CLI's local session state machine reports phase snapshots over the harness credential; the
 * owner states are then derived at chosen instants (explicit timestamps, no sleeps). How harness
 * events become phases (subagents, compaction, /clear) is the CLI's, tested there.
 */
const MIN = 60_000;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("observed state (hooks) scenarios",() => {
  let db: Database,app: ReturnType<typeof createApp>,principalId: string;
  const owner = "observed_owner_abcdefghijklmnopqrstuvwxyz0123456789";

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: "observed-scenarios-secret-with-32-characters" });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    hooks = ""; seqs.clear();
  });

  let hooks: string;
  const seqs = new Map<string,number>();
  /** One snapshot of the CLI's state machine for session `id`, reported at `at` (ms). */
  async function observe(id: string,phase: string,at: number,{ since = at,openToolSince = null as number | null } = {}) {
    if (!hooks) {
      const minted = await app.request("/api/harness-credentials",{ method: "POST",
        headers: { authorization: `Bearer ${owner}`,"content-type": "application/json" },body: JSON.stringify({ name: "Test Mac" }) });
      expect(minted.status).toBe(201);
      hooks = (await minted.json() as any).token;
    }
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id,seq);
    const response = await app.request("/api/agent-sessions/observed",{ method: "POST",
      headers: { authorization: `Bearer ${hooks}`,"content-type": "application/json" },
      body: JSON.stringify({ session: keyOf(id),harness: "claude-code",phase,phaseSince: new Date(since).toISOString(),
        lastSeenAt: new Date(at).toISOString(),openToolSince: openToolSince === null ? null : new Date(openToolSince).toISOString(),
        seq,computer: "Test Mac",project: "relo",account: "Work" }) });
    expect(response.status).toBe(200);
  }
  const keyOf = (id: string) => sessionKey({ harness: "claude-code",id }) as string;

  /** `relo work start` from the agent's shell (same key the CLI derives), declared at `at`. */
  async function startWork(id: string,at: number,goal = "Ship the release") {
    const response = await app.request("/api/session/works",{ method: "POST",
      headers: { authorization: `Bearer ${owner}`,"content-type": "application/json","idempotency-key": randomUUID(),
        "relo-session-key": detectCaller({ CLAUDE_CODE_SESSION_ID: id }).sessionKey,"relo-harness": "claude-code" },
      body: JSON.stringify({ goal: { readable: goal },context: { providerName: "Claude Code",project: "relo" } }) });
    expect(response.status).toBe(201);
    // Time travel for the fixture: the declared write happened at `at`.
    // A trigger stamps declared_at on every card write; replica mode lets the fixture set it.
    const connection = await (db as any).connect();
    try {
      await connection.query("SET session_replication_role = replica");
      await connection.query("UPDATE live_activities SET declared_at=$2,created_at=$2,updated_at=$2 WHERE principal_id=$1 AND session_key=$3",
        [principalId,new Date(at),keyOf(id)]);
    } finally { await connection.query("SET session_replication_role = origin"); connection.release(); }
    await db.query("UPDATE works SET created_at=$2,updated_at=$2,declared_at=$2 WHERE session_key=$1",[keyOf(id),new Date(at)]);
  }

  async function ownerState(id: string,now: number) {
    const works = await loadOwnerStateInputs(db,principalId,"visible",new Date(now));
    const mine = works.filter((work) => work.sessionKey === keyOf(id));
    expect(mine).toHaveLength(1);
    return deriveOwnerState(mine[0]!.input);
  }
  async function sessionRows(now: number) {
    const rows = (await db.query(`SELECT ${agentSessionRowsSql("$1::uuid")} AS rows`,[principalId])).rows[0].rows;
    return { raw: rows as any[],view: sessionsViewRows(rows,new Date(now)) };
  }
  const counts = async () => (await db.query(`SELECT (SELECT count(*) FROM live_activities)::int AS cards,
    (SELECT count(*) FROM works)::int AS works,(SELECT count(*) FROM interaction_requests)::int AS questions,
    (SELECT count(*) FROM notification_events)::int AS events`)).rows[0];

  test("one session key for hooks and CLI; nested harness ids are unidentified",async () => {
    const id = randomUUID();
    const caller = detectCaller({ CLAUDE_CODE_SESSION_ID: id,CLAUDECODE: "1" });
    expect(caller).toMatchObject({ type: "agent_session",harness: "claude-code",sessionKey: keyOf(id) });
    // RELO_SESSION never changes the key under a harness.
    expect(detectCaller({ CLAUDE_CODE_SESSION_ID: id,RELO_SESSION: "other" }).sessionKey).toBe(keyOf(id));
    expect(detectCaller({ CLAUDE_CODE_SESSION_ID: id,CODEX_THREAD_ID: "t-1" })).toEqual({ type: "unidentified",reason: "nested_harnesses" });
    const at = Date.now() - 10 * MIN;
    await startWork(id,at);
    await observe(id,"working",at + MIN);
    const { raw } = await sessionRows(at + MIN);
    expect(raw.map((row) => row.session_hash)).toEqual([keyOf(id)]);
    expect(raw[0].card_id).toBeTruthy(); // the observed session row and the CLI's work meet by key only
    expect((await ownerState(id,at + 21 * MIN)).evidenceSource).toBe("observed"); // the CLI's work sees the observed evidence
  });

  test("observed snapshots never write works, cards, questions or notifications",async () => {
    const id = randomUUID(); const at = Date.now() - 60 * MIN;
    const before = await counts();
    for (const [minute,phase] of [[0,"open"],[1,"working"],[6,"waiting"],[7,"working"],[8,"stopped"],[10,"ended"]] as const) {
      await observe(id,phase,at + minute * MIN);
    }
    expect(await counts()).toEqual(before);
    expect((await sessionRows(at + 11 * MIN)).raw).toHaveLength(1);
  });

  test("with hooks: working quietly, your turn, waiting on you (permission), stopped responding",async () => {
    const base = Date.now() - 120 * MIN;
    // Working quietly: the last declared write is old, the running turn was seen recently (a heartbeat).
    const quiet = randomUUID();
    await startWork(quiet,base);
    await observe(quiet,"working",base + MIN);
    await observe(quiet,"working",base + 25 * MIN,{ since: base + MIN });
    expect((await ownerState(quiet,base + 28 * MIN)).state).toBe("working_quietly");
    expect((await ownerState(quiet,base + 28 * MIN)).evidenceSource).toBe("observed");
    // ...and stopped responding once the running turn is unseen for T_fresh/2.
    expect((await ownerState(quiet,base + 36 * MIN)).state).toBe("stopped_responding");

    // A long tool keeps the turn working quietly up to T_retire from when it opened.
    const tool = randomUUID();
    await startWork(tool,base);
    await observe(tool,"working",base + 2 * MIN,{ openToolSince: base + 2 * MIN });
    expect((await ownerState(tool,base + 40 * MIN)).state).toBe("working_quietly");
    expect((await ownerState(tool,base + 63 * MIN)).state).toBe("stopped_responding");

    // Your turn: the turn stopped after the last write.
    const turn = randomUUID();
    await startWork(turn,base);
    await observe(turn,"stopped",base + 5 * MIN);
    expect((await ownerState(turn,base + 6 * MIN)).state).toBe("waiting_on_you");
    // ...for 5 minutes; then it is left open: Quiet and dimmed (12b-plan-ux 4.11), off the Lock Screen after an hour.
    expect(await ownerState(turn,base + 12 * MIN)).toMatchObject({ state: "stale",lockScreen: "dimmed",quietReason: "session_idle" });
    expect(await ownerState(turn,base + 100 * MIN)).toMatchObject({ state: "no_signal",lockScreen: "none",now: "quiet",quietReason: "session_idle" });

    // Permission prompt: needs you.
    const ask = randomUUID();
    await startWork(ask,base);
    await observe(ask,"waiting",base + 5 * MIN);
    expect(await ownerState(ask,base + 6 * MIN)).toMatchObject({ state: "needs_you",needsYou: "permission" });

    // Session ended without finishing: Quiet at once, with the reason.
    const gone = randomUUID();
    await startWork(gone,base);
    await observe(gone,"ended",base + 3 * MIN);
    expect(await ownerState(gone,base + 10 * MIN)).toMatchObject({ state: "stale",lockScreen: "dimmed",now: "quiet",quietReason: "session_ended" });
    expect((await ownerState(gone,base + 16 * MIN)).state).toBe("stale");
  });

  test("without hooks: declared timestamps only (moving, stale at 20 min, no signal at 60, left unfinished at 8 h)",async () => {
    const base = Date.now() - 10 * 60 * MIN;
    const id = randomUUID();
    await startWork(id,base);
    const at = async (minutes: number) => (await ownerState(id,base + minutes * MIN)).state;
    expect(await at(10)).toBe("moving");
    expect(await at(21)).toBe("stale");
    expect(await at(61)).toBe("no_signal");
    expect(await at(8 * 60 + 1)).toBe("left_unfinished");
    for (const minutes of [5,15,25,45,90,300]) {
      expect(["waiting_on_you","working_quietly","stopped_responding","needs_you"]).not.toContain(await at(minutes));
    }
    const { view } = await sessionRows(base + 10 * MIN);
    expect(view).toEqual([]); // no observed row; the hook-less Sessions row comes from the work (now-routes)
  });

  test("a new session (after /clear) never touches the old work, which fades",async () => {
    const base = Date.now() - 10 * 60 * MIN;
    const old = randomUUID(); const fresh = randomUUID();
    await startWork(old,base);
    await observe(old,"working",base + MIN);
    let rows = await sessionRows(base + 4 * MIN);
    expect(rows.raw).toHaveLength(1);
    expect(rows.view[0]).toMatchObject({ phase: "working",waitingFor: null });
    await observe(old,"ended",base + 5 * MIN);
    await observe(fresh,"open",base + 5 * MIN + 1);
    rows = await sessionRows(base + 6 * MIN);
    expect(rows.raw.map((row) => row.session_hash).sort()).toEqual([keyOf(old),keyOf(fresh)].sort());
    expect(rows.raw.find((row) => row.session_hash === keyOf(fresh)).card_id).toBeNull(); // nothing of the old work
    // An ended session's card is a finished item: the final card for T_done (15 minutes), then History only.
    expect((await ownerState(old,base + 18 * MIN)).state).toBe("stale");
    expect(await ownerState(old,base + 21 * MIN)).toMatchObject({ state: "no_signal",lockScreen: "none",now: null });
    // The fresh session writing later never touches the old work.
    await startWork(fresh,base + 30 * MIN,"Another goal");
    expect((await ownerState(old,base + 31 * MIN)).state).toBe("no_signal");
  });

  test("a turn that stops under a declared wait (a background job) is moving and working, not the owner's turn",async () => {
    const base = Date.now() - 30 * MIN;
    const id = randomUUID();
    await startWork(id,base);
    // `relo work update --waiting "the deploy"` in the same turn, then the turn stops.
    await db.query("UPDATE works SET waiting_reason='the deploy',waiting_since=$2 WHERE session_key=$1",[keyOf(id),new Date(base)]);
    await observe(id,"stopped",base + MIN);
    expect((await ownerState(id,base + 2 * MIN)).state).toBe("moving");
    expect((await sessionRows(base + 2 * MIN)).view[0]).toMatchObject({ phase: "working",waitingFor: null });
    // Past T_retire the declared wait no longer holds it: the stopped turn was left open long ago, so it is Quiet.
    expect(await ownerState(id,base + 61 * MIN)).toMatchObject({ state: "no_signal",quietReason: "session_idle" });
  });
});
