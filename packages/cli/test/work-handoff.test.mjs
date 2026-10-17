// Handoff (plan 12 §5.1b): relo work handoff / start --from, the pending file on this computer, the
// SessionStart offer, the SessionEnd(clear) release, and the state line. A fake works server shared by two
// sessions of one computer (one state folder, one project).
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { ReloApiClient } from "../src/shared/api-client.mjs";
import claudeCode from "../src/harness/adapters/claude-code/index.mjs";
import { runHarnessRole } from "../src/harness/core/roles.mjs";
import { offerText } from "../src/harness/core/handoff-offer.mjs";
import { sessionKey } from "../src/shared/session-key.mjs";

const worksContract = new URL("../../contracts/dist/src/works.js", import.meta.url);
const skip = !existsSync(worksContract) && "build @relo/notification-contracts first";
const A = "11111111-aaaa-4aaa-8aaa-000000000001";
const B = "22222222-bbbb-4bbb-8bbb-000000000002";

function server(c) {
  const works = [];
  const handoffs = new Map();
  const calls = [];
  let n = 0;
  const respond = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => structuredClone(body) });
  const view = (w) => { const { owner: _, ...rest } = w; return { ...rest, plan: { ...w.plan, complete: c.planComplete(w.plan) } }; };
  const live = (key) => works.filter((w) => w.owner === key && (w.lifecycle === "open" || w.lifecycle === "paused"));
  const answer = (w, key, disposition, extra = {}) => ({ status: 200, body: { work: view(w), disposition, replayed: false, ignored: [], parked: live(key).filter((x) => x !== w && x.lifecycle === "paused").map(view), ...extra } });
  const send = (out) => respond(out.body, out.status);
  const refuse = (error, status = 409) => ({ status, body: { error, message: `${error} (fixture)` } });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const key = init.headers["relo-session-key"];
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: u.pathname, body, key });
    if (init.method === "GET") {
      const mine = live(key);
      return respond({ open: mine.find((w) => w.lifecycle === "open")?.id ? view(mine.find((w) => w.lifecycle === "open")) : null, parked: mine.filter((w) => w.lifecycle === "paused").map(view) });
    }
    if (u.pathname === "/api/session/works") {
      if (body.from) {
        const h = handoffs.get(body.from);
        if (!h || h.used) return send(refuse("handoff_invalid"));
        const w = works.find((x) => x.id === h.workId);
        if (w.lifecycle === "finished") return send(refuse("handoff_finished"));
        const own = live(key).find((x) => x.lifecycle === "open");
        if (own) { own.lifecycle = "paused"; own.pausedReason = "parked"; }
        h.used = true; w.owner = key; w.lifecycle = "open";
        return send(answer(w, key, "taken_over"));
      }
      const w = { id: `wrk_${(++n).toString(16).padStart(8, "c")}-0000`, owner: key, version: 1, lifecycle: "open", pausedReason: null, sealed: false, goal: body.goal.readable,
        status: null, outcome: null, waiting: null, plan: c.EMPTY_WORK_PLAN, progress: null, card: null };
      if (body.plan) { const r = c.applyPlanCommand(w.plan, body.plan, 1, { sealed: false }); if (!r.ok) return send(refuse(r.code, 422)); w.plan = r.plan; }
      works.push(w);
      return send({ ...answer(w, key, "started"), status: 201 });
    }
    const m = u.pathname.match(/works\/([^/]+)\/(\w+)$/u);
    if (m?.[2] === "handoff") {
      const w = works.find((x) => x.owner === key && (m[1] === "current" ? x.lifecycle === "open" : x.id === m[1]));
      if (!w) return send(refuse("not_open"));
      w.status = body.next.readable; w.version += 1;
      const handle = `rh_${"abcdefghijklmnopqrstuvwxyz0123456789"}${n}`;
      for (const [k, v] of handoffs) if (v.workId === w.id) handoffs.delete(k);
      handoffs.set(handle, { workId: w.id, used: false });
      return send(answer(w, key, "handed_off", { handoff: { handle, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }));
    }
    return send(refuse("invalid_request", 400));
  };
  return { fetchImpl, works, calls, handoffs };
}

async function computer() {
  const c = await import(worksContract.href);
  const state = mkdtempSync(join(tmpdir(), "relo-handoff-"));
  const repo = join(state, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const srv = server(c);
  const session = (id, cwd = repo) => {
    const env = { XDG_STATE_HOME: state, CLAUDE_CODE_SESSION_ID: id, RELO_KEY_STORE_PATH: join(state, "e2ee.json") };
    const overrides = {
      env, cwd,
      loadConfig: async () => ({ apiUrl: "http://relo.test", token: "t".repeat(44) }),
      configPath: () => join(state, "config.json"),
      clientFactory: (config) => new ReloApiClient({ apiUrl: config.apiUrl, token: config.token, fetchImpl: srv.fetchImpl }),
    };
    return { relo: async (...argv) => {
      const out = [];
      const code = await run(argv, { stdout: (l) => out.push(l), stderr: (l) => out.push(l), stdoutIsTTY: false }, overrides);
      return { code, text: out.join("\n") };
    }, overrides };
  };
  const handoffDir = join(state, "relo", "handoffs");
  const pendingFile = () => { const names = existsSync(handoffDir) ? readdirSync(handoffDir).filter((name) => name.endsWith(".json")) : []; return names[0] ? join(handoffDir, names[0]) : undefined; };
  return { state, repo, srv, session, handoffDir, pendingFile, done: () => rmSync(state, { recursive: true, force: true }) };
}

const handleOf = (text) => /relo work start --from (rh_[A-Za-z0-9_-]+)/u.exec(text)?.[1];

test("handoff: the echo gives the handle and the owner line; the pending file is private; the old session loses the work", { skip }, async (t) => {
  const pc = await computer(); t.after(pc.done);
  const a = pc.session(A);
  assert.equal((await a.relo("work", "start", "--goal", "Ship the handoff", "--plan", "Build the server,Build the CLI,Test it")).code, 0);
  const r = await a.relo("work", "handoff", "--next", "Wire the CLI verb");
  assert.equal(r.code, 0, r.text);
  const handle = handleOf(r.text);
  assert.ok(handle, r.text);
  assert.match(r.text, /^Handoff: in the next session on this computer, run: relo work start --from rh_/mu);
  assert.match(r.text, /^Owner sees: "Handing off: Wire the CLI verb"$/mu);
  assert.ok(r.text.indexOf("[>] s1 Build the server") < r.text.indexOf("Handoff:"), "the plan comes first");
  assert.deepEqual(pc.srv.calls.at(-1).body, { next: { readable: "Handing off: Wire the CLI verb" } });
  const file = pc.pendingFile();
  assert.ok(file, "pending file written");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(pc.handoffDir).mode & 0o777, 0o700);
  const pending = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(pending).sort(), ["copy", "createdAt", "expiresAt", "fromSession", "goal", "handle", "next", "round", "status", "v", "workId", "writtenAt"]);
  assert.equal(pending.handle, handle);
  assert.deepEqual([pending.goal, pending.next, pending.round.n], ["Ship the handoff", "Wire the CLI verb", 1]);
  assert.notEqual(pending.fromSession, sessionKey({ harness: "claude-code", id: A }), "only a hash of the session key");
  assert.ok(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt) > 23 * 3_600_000);
  // The old session's file dropped the work.
  const state = await a.relo("state");
  assert.match(state.text, /No open work in this session/u);
  assert.doesNotMatch(state.text, /Handoff waiting/u, "the handing-off session is not offered its own handoff");
});

test("start --from takes the work over: plan and note echoed, pending file removed, the session holds it", { skip }, async (t) => {
  const pc = await computer(); t.after(pc.done);
  const a = pc.session(A); const b = pc.session(B);
  await a.relo("work", "start", "--goal", "Ship the handoff", "--plan", "Build the server,Build the CLI");
  const handle = handleOf((await a.relo("work", "handoff", "--next", "Wire the CLI verb")).text);
  const waiting = await b.relo("state");
  assert.match(waiting.text, /^Handoff waiting for this project: "Ship the handoff", next: "Wire the CLI verb"\. Continue it: relo work start --from rh_/mu);
  const taken = await b.relo("work", "start", "--from", handle);
  assert.equal(taken.code, 0, taken.text);
  assert.match(taken.text, /\(open, taken_over\)/u);
  assert.match(taken.text, /Status: Handing off: Wire the CLI verb/u);
  assert.match(taken.text, /\[>\] s1 Build the server/u);
  assert.deepEqual(pc.srv.calls.at(-1).body, { from: handle }, "only the handle travels");
  assert.equal(pc.pendingFile(), undefined, "the pending file is removed");
  assert.equal(pc.srv.works[0].owner, sessionKeyHeader(pc, B));
  const mine = await b.relo("state");
  assert.match(mine.text, /Work wrk_\w+ "Ship the handoff"/u);
  assert.doesNotMatch(mine.text, /Handoff waiting/u);
  assert.match((await a.relo("state")).text, /No open work in this session/u);
  // The handle is single use.
  const again = await pc.session(A).relo("work", "start", "--from", handle);
  assert.notEqual(again.code, 0);
  assert.match(again.text, /handoff_invalid|not valid|HANDOFF_INVALID/iu);
});
test("a plain start naming the goal just handed off here takes it over; another goal starts its own work", { skip }, async (t) => {
  const pc = await computer(); t.after(pc.done);
  const a = pc.session(A); const b = pc.session(B);
  await a.relo("work", "start", "--goal", "Ship the handoff", "--plan", "Build the server,Build the CLI");
  const handle = handleOf((await a.relo("work", "handoff", "--next", "Wire the CLI verb")).text);
  const taken = await b.relo("work", "start", "--goal", "ship the  handoff", "--plan", "Something else");
  assert.equal(taken.code, 0, taken.text);
  assert.match(taken.text, /\(open, taken_over\)/u);
  assert.match(taken.text, /this start took it over instead of opening a second card/u);
  assert.deepEqual(pc.srv.calls.at(-1).body, { from: handle }, "only the handle travels");
  assert.equal(pc.srv.works.length, 1, "no second card");
  assert.equal(pc.pendingFile(), undefined);

  const c = pc.session("33333333-cccc-4ccc-8ccc-000000000003");
  await b.relo("work", "handoff", "--next", "Finish the docs");
  const other = await c.relo("work", "start", "--goal", "Fix the landing page");
  assert.equal(other.code, 0, other.text);
  assert.doesNotMatch(other.text, /taken_over/u);
  assert.equal(pc.srv.works.length, 2);
});
const sessionKeyHeader = (pc, id) => pc.srv.calls.findLast((call) => call.key && call.key === sessionKey({ harness: "claude-code", id }))?.key;

test("start --from refuses what contradicts it, a malformed handle, and a handle the server refuses clears the pending file", { skip }, async (t) => {
  const pc = await computer(); t.after(pc.done);
  const a = pc.session(A); const b = pc.session(B);
  await a.relo("work", "start", "--goal", "Ship the handoff");
  const handle = handleOf((await a.relo("work", "handoff", "--next", "Wire the CLI verb")).text);
  let r = await b.relo("work", "start", "--from", handle, "--goal", "Something else");
  assert.equal(r.code, 2); assert.match(r.text, /--goal and --from contradict/u);
  r = await b.relo("work", "start", "--from", "nope");
  assert.equal(r.code, 2); assert.match(r.text, /not a handoff handle/u);
  pc.srv.handoffs.clear();
  r = await b.relo("work", "start", "--from", handle);
  assert.notEqual(r.code, 0); assert.match(r.text, /^Next: relo work start --goal/mu);
  assert.equal(pc.pendingFile(), undefined, "a handle the server refuses is dropped from the computer");
  r = await b.relo("work", "start", "--from", handle, "--dry-run");
  assert.equal(r.code, 0); assert.match(r.text, /Dry run/u);
});

test("handoff refusals: no note, a note that is too long or a placeholder, and a dry run", { skip }, async (t) => {
  const pc = await computer(); t.after(pc.done);
  const a = pc.session(A);
  await a.relo("work", "start", "--goal", "Ship the handoff");
  let r = await a.relo("work", "handoff");
  assert.equal(r.code, 2); assert.match(r.text, /needs a note/u);
  r = await a.relo("work", "handoff", "--next", "x".repeat(130));
  assert.equal(r.code, 2); assert.match(r.text, /the limit is 107/u);
  r = await a.relo("work", "handoff", "--next", "todo");
  assert.equal(r.code, 2); assert.match(r.text, /placeholder/u);
  assert.equal(pc.pendingFile(), undefined);
  assert.equal(pc.srv.calls.filter((call) => call.path.endsWith("/handoff")).length, 0, "refused before any request");
  const dry = await a.relo("work", "handoff", "--next", "Wire the CLI verb", "--dry-run");
  assert.match(dry.text, /Owner sees: "Handing off: Wire the CLI verb"/u);
  assert.equal(pc.srv.calls.filter((call) => call.path.endsWith("/handoff")).length, 0);
});

// --- hooks ---

function hookDeps(pc, { now, sessionFiles = {}, extra = {} } = {}) {
  return { env: {}, cwd: pc.repo, now: () => now, hookStateDirectory: join(pc.state, "hooks"), sessionsDirectory: join(pc.state, "relo", "sessions"),
    handoffsDirectory: pc.handoffDir, ...extra };
}
const startInput = (id, source, cwd) => ({ session_id: id, hook_event_name: "SessionStart", source, cwd });

async function restoreOffer(pc, id, source, now = Date.now(), extra = {}) {
  const out = [];
  const outcome = await runHarnessRole({ adapter: claudeCode, role: "restore", input: startInput(id, source, pc.repo), dependencies: { ...hookDeps(pc, { now }), emit: (line) => out.push(line), ...extra } });
  return { outcome, context: out[0]?.hookSpecificOutput?.additionalContext };
}

test("SessionStart offers a waiting handoff from another session, within 400 characters, never to the one that handed off", { skip }, async (t) => {
  const pc = await computer(); t.after(pc.done);
  const a = pc.session(A);
  await a.relo("work", "start", "--goal", "Ship the handoff", "--plan", "Build the server,Build the CLI");
  const handle = handleOf((await a.relo("work", "handoff", "--next", "Wire the CLI verb")).text);
  for (const source of ["startup", "clear", "resume"]) {
    const { context } = await restoreOffer(pc, B, source);
    assert.equal(context, `Relo: a handoff is waiting from another session: "Ship the handoff", round 1, next: "Wire the CLI verb". Continue it: relo work start --from ${handle}. A new goal instead: relo work start --new --goal "…".`, source);
    assert.ok(context.length <= 400);
  }
  assert.equal((await restoreOffer(pc, B, "compact")).context, undefined, "compact is not a new session");
  assert.equal((await restoreOffer(pc, A, "clear")).context, undefined, "not offered to the session that handed off");
  assert.equal((await restoreOffer(pc, B, "startup", Date.now() + 25 * 3_600_000)).context, undefined, "expired");
  // Another project sees nothing.
  const other = join(pc.state, "other"); mkdirSync(join(other, ".git"), { recursive: true });
  const out = [];
  await runHarnessRole({ adapter: claudeCode, role: "restore", input: startInput(B, "startup", other), dependencies: { ...hookDeps(pc, { now: Date.now() }), cwd: other, emit: (line) => out.push(line) } });
  assert.equal(out.length, 0);
  // A session with its own open work is still offered, and told so.
  const b = pc.session(B);
  await b.relo("work", "start", "--goal", "Something of my own");
  const own = await restoreOffer(pc, B, "resume");
  assert.match(own.context, /This session has its own open work; taking over parks it\.$/u);
  assert.match(own.context, /Relo: this session has open work/u, "the session's own restore comes first");
});

test("the offer names only goal, round title and the note, and long text is cut to the budget", () => {
  const long = "w".repeat(300);
  const text = offerText({ handle: `rh_${"z".repeat(32)}`, goal: long, round: { n: 3, title: long }, next: long }, { ownOpen: true });
  assert.ok(text.length <= 400, String(text.length));
  assert.match(text, /^Relo: a handoff is waiting from another session: "/u);
  assert.match(text, /relo work start --from rh_z+/u);
});

test("SessionEnd with reason clear hands the open work off through the session's own relo; other reasons do nothing", { skip }, async (t) => {
  const pc = await computer(); t.after(pc.done);
  const a = pc.session(A);
  await a.relo("work", "start", "--goal", "Ship the handoff");
  const ran = [];
  const runRelo = async (args, options) => { ran.push({ args, options }); return { code: 0, stdout: "" }; };
  const endInput = (reason, id = A) => ({ session_id: id, hook_event_name: "SessionEnd", reason, cwd: pc.repo });
  const release = (reason, extra = {}) => runHarnessRole({ adapter: claudeCode, role: "release", input: endInput(reason), dependencies: { ...hookDeps(pc, { now: Date.now() }), runRelo, ...extra } });
  for (const reason of ["logout", "prompt_input_exit", "other", undefined]) {
    assert.deepEqual(await release(reason), { printed: false, role: "release" }, String(reason));
  }
  assert.equal(ran.length, 0, "no handoff for any other reason");
  const done = await release("clear");
  assert.equal(done.handoff, true);
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].args, ["work", "handoff", "--next", "after /clear"]);
  assert.equal(ran[0].options.env.CLAUDE_CODE_SESSION_ID, A, "acts as the ending session");
  assert.equal(ran[0].options.cwd, pc.repo);
  // No open work (nothing to hand off), a delivered round, a slow or failing handoff.
  ran.length = 0;
  const empty = { ...hookDeps(pc, { now: Date.now() }), runRelo };
  assert.equal((await runHarnessRole({ adapter: claudeCode, role: "release", input: endInput("clear", B), dependencies: empty })).handoff, undefined);
  assert.equal(ran.length, 0);
  assert.equal((await release("clear", { runRelo: async () => ({ code: 2 }) })).handoff, undefined);
  const started = Date.now();
  const slow = await release("clear", { runRelo: () => new Promise(() => {}), releaseWaitMs: 50 });
  assert.equal(slow.handoff, undefined);
  assert.ok(Date.now() - started < 1_000, "a slow handoff never holds the hook past its wait");
});

test("the real handoff verb run as the ending session leaves a handle for the cleared session's start", { skip }, async (t) => {
  const pc = await computer(); t.after(pc.done);
  const a = pc.session(A);
  await a.relo("work", "start", "--goal", "Ship the handoff", "--plan", "Build it,Test it");
  // The hook's child is `relo work handoff --next "after /clear"` as session A; the next session B is offered it.
  const r = await a.relo("work", "handoff", "--next", "after /clear");
  assert.equal(r.code, 0, r.text);
  const { context } = await restoreOffer(pc, B, "clear");
  assert.match(context, /next: "after \/clear"\. Continue it: relo work start --from rh_/u);
});

test("a sealed work taken over still shows its real words: the pending file holds the labels this computer wrote", { skip }, async (t) => {
  const pc = await computer(); t.after(pc.done);
  const a = pc.session(A); const b = pc.session(B);
  await a.relo("work", "start", "--goal", "Ship the handoff", "--plan", "Build the server,Build the CLI");
  const handle = handleOf((await a.relo("work", "handoff", "--next", "Wire the CLI verb")).text);
  // What a sealed account's server holds: no text at all.
  const work = pc.srv.works[0];
  work.sealed = true; work.goal = null; work.status = null;
  work.plan = { ...work.plan, steps: work.plan.steps.map(({ label: _, ...step }) => step) };
  const taken = await b.relo("work", "start", "--from", handle);
  assert.equal(taken.code, 0, taken.text);
  assert.match(taken.text, /"Ship the handoff" \(open, taken_over\)/u);
  assert.match(taken.text, /\[>\] s1 Build the server/u);
  assert.match(taken.text, /Status: Handing off: Wire the CLI verb/u);
  // The plan line reads "Step 1 of 2 · <label>" (plan 12b U2); never a bare placeholder "Step 1" or a null label.
  assert.match(taken.text, /Step 1 of 2 · Build the server/u);
  assert.doesNotMatch(taken.text, /Step 1(?! of)|null/u);
});
