import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { ReloApiClient } from "../src/shared/api-client.mjs";
import { applyChange, startPlan } from "../src/work/plan.mjs";

function fakeServer() {
  const works = [];
  const calls = [];
  let n = 0;
  const respond = (o, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => o });
  const open = () => works.find((w) => w.lifecycle === "open");
  const parked = () => works.filter((w) => w.lifecycle === "paused");
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: u.pathname, headers: init.headers, body });
    if (init.method === "GET") return respond({ open: open() ?? null, parked: parked() });
    if (init.method === "POST" && u.pathname === "/api/session/works") {
      // Wire shape of contracts/works.ts: declared text is {readable}, plans are commands.
      assert.equal(typeof body.goal?.readable, "string");
      if (body.status) assert.equal(typeof body.status.readable, "string");
      if (body.plan) assert.equal(body.plan.op, "set");
      assert.match(init.headers["relo-session-key"], /^[A-Za-z0-9_-]{16,128}$/u);
      const cur = open();
      if (cur) cur.lifecycle = "paused";
      const steps = (body.plan?.steps ?? []).map((s, i) => ({ id: `s${i + 1}`, label: s.label, state: i === 0 ? "current" : "open", addedIn: 1 }));
      const w = { id: `wrk_${(++n).toString(16).padStart(8, "a")}-0000`, version: 1, lifecycle: "open", goal: body.goal.readable, status: body.status?.readable ?? null,
        plan: { version: 1, next: steps.length + 1, complete: false, steps }, progress: body.progress ?? null, card: { id: "act_1", state: "active" } };
      works.push(w);
      return respond({ disposition: cur ? "switched" : "started", work: w, parked: parked(), replayed: false, ignored: [] }, 201);
    }
    const m = u.pathname.match(/works\/([^/]+)(?:\/(\w+))?$/u);
    const w = works.find((x) => x.id === m[1]);
    if (!w) return respond({ error: "not_found", message: "Work not found in this session." }, 404);
    if (init.method === "PATCH") {
      if (body.status) w.status = body.status.readable;
      const plan = body.plan;
      if (plan?.op === "next") {
        const cur = w.plan.steps.find((s) => s.state === "current");
        if (cur) cur.state = "done";
        const nxt = w.plan.steps.find((s) => s.state === "open");
        if (nxt) nxt.state = "current";
      } else if (plan?.op === "add") {
        for (const s of plan.steps) w.plan.steps.push({ id: `s${w.plan.next++}`, label: s.label, state: "open", addedIn: w.version + 1 });
      } else if (plan) {
        assert.ok(["revise", "step"].includes(plan.op), `plan op ${plan.op}`);
      }
      if (body.progress) {
        const cur = w.plan.steps.find((s) => s.state === "current");
        if (cur) cur.progress = body.progress; else w.progress = body.progress;
      }
      w.version += 1;
      return respond({ disposition: "updated", work: w, parked: parked(), replayed: false, ignored: [] });
    }
    if (m[2] === "finish") { assert.equal(typeof body.outcome.readable, "string"); w.lifecycle = "finished"; w.result = body.result; w.outcome = body.outcome.readable; return respond({ disposition: "finished", work: w, parked: parked() }); }
    if (m[2] === "deliver") {
      w.plan.rounds = [{ n: 1, state: "closed", outcome: body.outcome.readable }];
      w.plan.steps = w.plan.steps.map((x) => ({ ...x, round: 1, state: x.state === "current" ? "done" : x.state === "open" ? "skipped" : x.state }));
      return respond({ disposition: "delivered", work: w, parked: [] });
    }
    if (m[2] === "pause") { w.lifecycle = "paused"; w.status = body.status.readable; return respond({ disposition: "paused", work: w, parked: [] }); }
    w.lifecycle = "open";
    return respond({ disposition: "resumed", work: w, parked: [] });
  };
  return { fetchImpl, calls };
}

function session(env) {
  const state = mkdtempSync(join(tmpdir(), "relo-work-"));
  const server = fakeServer();
  const overrides = {
    env: { XDG_STATE_HOME: state, ...env },
    loadConfig: async () => ({ apiUrl: "http://relo.test", token: "t".repeat(44) }),
    configPath: () => join(state, "config.json"),
    clientFactory: (c) => new ReloApiClient({ apiUrl: c.apiUrl, token: c.token, fetchImpl: server.fetchImpl }),
  };
  const relo = async (...argv) => {
    const out = [];
    const code = await run(argv, { stdout: (l) => out.push(l), stderr: (l) => out.push(l), stdoutIsTTY: false }, overrides);
    return { code, text: out.join("\n") };
  };
  return { relo, server, state, done: () => rmSync(state, { recursive: true, force: true }) };
}

test("start, update, repeat start and finish print the echo and keep one work per session", async (t) => {
  const s = session({ CLAUDE_CODE_SESSION_ID: "session-one" });
  t.after(s.done);
  let r = await s.relo("work", "start", "--goal", "Fix the login crash", "--plan", "Reproduce the crash,Find the cause");
  assert.equal(r.code, 0);
  assert.match(r.text, /^Work wrk_aaaaaaa1 "Fix the login crash" \(open, started\)/u);
  assert.match(r.text, /\[>\] s1 Reproduce the crash/u);
  assert.match(r.text, /Owner sees: on the Lock Screen, "Step 1 of 2 · Reproduce the crash"/u);
  assert.equal(s.server.calls[0].headers["relo-harness"], "claude-code");
  assert.ok(s.server.calls.every((c) => c.headers["relo-session-key"]));
  const file = statSync(join(s.state, "relo", "sessions"));
  if (process.platform !== "win32") assert.equal(file.mode & 0o777, 0o700);
  const before = s.server.calls.length;
  r = await s.relo("work", "start", "--goal", "Release 0.17");
  assert.match(r.text, /\(open, continuing\)/u);
  assert.equal(s.server.calls.length, before, "a continuing start sends nothing");
  r = await s.relo("work", "update", "--next-step", "--progress", "2/6");
  assert.match(r.text, /\[>\] s2 Find the cause {3}\(2\/6\)/u);
  r = await s.relo("work", "finish", "--outcome", "Login fixed and tested");
  assert.match(r.text, /\(finished, done\)/u);
  r = await s.relo("state");
  assert.match(r.text, /^No open work in this session\./u);
});

test("refused flags and verbs refuse in three lines before any request", async (t) => {
  const s = session({ CLAUDE_CODE_SESSION_ID: "session-two" });
  t.after(s.done);
  for (const argv of [["work", "start", "--goal", "Ship it", "--name", "x"], ["work", "start", "--goal", "Ship it", "--expires-in", "1h"],
    ["work", "heartbeat"], ["work", "start", "--goal", "todo"], ["work", "update", "--status", "Testing"]]) {
    const r = await s.relo(...argv);
    assert.equal(r.code, 2, argv.join(" "));
    const lines = r.text.split("\n");
    assert.equal(lines.length, 3, r.text);
    assert.match(lines[0], /^Refused: /u);
    assert.match(lines[1], /^State: /u);
    assert.match(lines[2], /^Next: /u);
  }
  assert.ok(s.server.calls.every((c) => c.method === "GET"), "only reads");
});

test("unidentified callers get a handle and must pass it", async (t) => {
  const s = session({ GEMINI_CLI: "1" });
  t.after(s.done);
  const r = await s.relo("work", "start", "--goal", "Polish 20 chapters", "--progress", "3/20");
  assert.match(r.text, /^Handle: wrk_aaaaaaa1\.[A-Za-z0-9_-]{22} /mu);
  assert.equal(s.server.calls[0].headers["relo-harness"], "handle.gemini-cli");
  const refused = await s.relo("work", "update", "--status", "Chapter four");
  assert.match(refused.text, /^Refused: this shell has no session id \(Gemini CLI\)/u);
});

test("plan rules: --plan lists what is left; unlisted current is skipped; ids never reused", () => {
  const { plan } = startPlan(["Reproduce the crash", "Find the cause", "Choose the fix"]);
  const step1 = applyChange(plan, { nextStep: true }).plan;
  const revised = applyChange(step1, { nextStep: true, plan: ["Patch token refresh", "Add regression test"] });
  assert.deepEqual(revised.plan.steps.map((s) => `${s.id}:${s.state}`), ["s1:done", "s2:done", "s4:current", "s5:open", "s3:skipped"]);
  const collapsed = applyChange(startPlan(["A one", "B two", "C three"]).plan, { plan: ["Write six plan sections"], progress: { done: 2, total: 6 } });
  assert.equal(collapsed.plan.steps.filter((s) => s.state === "current").length, 1);
  assert.deepEqual(collapsed.plan.steps.find((s) => s.state === "current").progress, { done: 2, total: 6 });
  assert.equal(collapsed.plan.steps.find((s) => s.label === "Write six plan sections").id, "s4");
});

const worksContract = new URL("../../contracts/dist/src/works.js", import.meta.url);
test("every relo work request body parses with the server's schemas (contracts/works.ts)", { skip: !existsSync(worksContract) && "build @relo/notification-contracts first" }, async (t) => {
  const c = await import(worksContract.href);
  const s = session({ CLAUDE_CODE_SESSION_ID: "session-contract" });
  t.after(s.done);
  for (const argv of [
    ["work", "start", "--goal", "Fix the login crash", "--plan", "Reproduce the crash,Find the cause", "--status", "Reading the logs"],
    ["work", "update", "--next-step", "--progress", "2/6", "--status", "Bisecting commits"],
    ["work", "update", "--add", "Write a regression test", "--waiting", "CI"],
    ["work", "update", "--plan", "Find the cause,Write a regression test", "--not-waiting"],
    ["work", "update", "--step", "s3", "--goal", "Fix the login crash on iOS"],
    ["work", "pause", "--status", "Waiting for the design review"],
    ["work", "resume"],
    ["work", "finish", "--failed", "--outcome", "Crash not reproducible on device"],
  ]) assert.equal((await s.relo(...argv)).code, 0, argv.join(" "));
  const schema = (call) => call.method === "PATCH" ? c.workUpdateRequestSchema
    : call.path === "/api/session/works" ? c.workStartRequestSchema
      : call.path.endsWith("/pause") ? c.workPauseRequestSchema
        : call.path.endsWith("/resume") ? c.workResumeRequestSchema
          : call.path.endsWith("/finish") ? c.workFinishRequestSchema : undefined;
  const writes = s.server.calls.filter((call) => call.method !== "GET");
  assert.ok(writes.length >= 8);
  for (const call of writes) {
    const parsed = schema(call).safeParse(call.body);
    assert.ok(parsed.success, `${call.method} ${call.path} ${JSON.stringify(call.body)}: ${parsed.error?.message}`);
    assert.ok(call.headers["idempotency-key"], `${call.method} ${call.path} carries an idempotency key`);
  }
});

test("deliver with open top-level steps is refused before any request; --drop-rest delivers and names the skipped steps", async (t) => {
  const s = session({ CLAUDE_CODE_SESSION_ID: "session-deliver" });
  t.after(s.done);
  await s.relo("work", "start", "--goal", "Build four batches", "--plan", "Batch 1,Batch 2,Batch 3,Batch 4");
  await s.relo("work", "update", "--next-step");
  const writes = () => s.server.calls.filter((c) => c.method !== "GET").length;
  const before = writes();
  let r = await s.relo("work", "deliver", "--outcome", "Batch 1 built");
  assert.equal(r.code, 2, r.text);
  const lines = r.text.split("\n");
  assert.equal(lines.length, 3, r.text);
  assert.match(lines[0], /^Refused: Round 1 still has open steps: s3 Batch 3, s4 Batch 4/u);
  assert.match(lines[2], /relo ask "…" --approval/u);
  assert.match(lines[2], /--drop-rest/u);
  assert.equal(writes(), before, "nothing was sent");
  r = await s.relo("work", "deliver", "--outcome", "Batch 1 built", "--drop-rest");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Note: skipped 2 open steps \(--drop-rest\): s3 Batch 3, s4 Batch 4/u);
  assert.equal(s.server.calls.at(-1).body.dropRest, true);
  r = await s.relo("work", "start", "--round", "Batch 3 and 4");
  assert.equal(s.server.calls.at(-1).body.plan, undefined, "no plan is sent: the round carries the unfinished steps");
  assert.deepEqual(s.server.calls.at(-1).body.round, { readable: "Batch 3 and 4" });
});

test("--say is checked like card text, and a readable work says it was not sent instead of dropping it silently", async (t) => {
  const s = session({ CLAUDE_CODE_SESSION_ID: "session-say" });
  t.after(s.done);
  await s.relo("work", "start", "--goal", "Ship the release");
  let r = await s.relo("work", "deliver", "--outcome", "Built", "--say", "x".repeat(161));
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /--say is 161 characters; the limit is 160/u);
  r = await s.relo("work", "deliver", "--outcome", "Built", "--say", "Version 0.17 is live.");
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /--say contains a version number; it is said aloud/u);
  r = await s.relo("work", "deliver", "--outcome", "Built", "--say", "See /Users/me/repo/file.txt");
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /contains a file path/u);
  r = await s.relo("work", "deliver", "--outcome", "Built and shipped", "--say", "The release is live.");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Note: --say was not sent: this work is readable/u);
  assert.equal(JSON.stringify(s.server.calls.at(-1).body).includes("The release is live"), false, "nothing readable carries it");
  assert.match(r.text, /^Mac says: "Your turn: Ship the release\."$/mu, "a readable work's line is the frame alone");
});

test("--spoken-name is checked for the ear, and deliver and finish echo the line Relo for Mac says (ADR 0015)", async (t) => {
  const s = session({ CLAUDE_CODE_SESSION_ID: "session-name" });
  t.after(s.done);
  let r = await s.relo("work", "start", "--goal", "Redesign the open notch view of Relo for Mac", "--spoken-name", "The big open notch redesign");
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /--spoken-name is 5 words; it is said aloud, so at most 4/u);
  r = await s.relo("work", "start", "--goal", "Redesign the open notch view of Relo for Mac", "--spoken-name", "Notch redesign");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^Note: voice is verbose here \(the default\): Relo for Mac says "<Kind>: <name>\. <gist>" and each finished step/mu, "the agent learns what to write for the ear");
  assert.equal(JSON.stringify(s.server.calls.at(-1).body).includes("Notch redesign"), false, "the name never reaches the server readable");
  r = await s.relo("work", "update", "--spoken-name", "Open notch");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Note: --spoken-name was not sent: this work is readable/u);
  r = await s.relo("work", "finish", "--outcome", "Server 0.18.99 is live: cards are uniform (iPhone 0.10.40)", "--failed");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^Mac says: "Failed: Open notch\."$/mu);
});

test("RELO_VOICE=off: the start says nothing is said aloud and deliver echoes no line (ADR 0015 revision 1)", async (t) => {
  const s = session({ CLAUDE_CODE_SESSION_ID: "session-voice-off", RELO_VOICE: "off" });
  t.after(s.done);
  let r = await s.relo("work", "start", "--goal", "Rotate the confidential signing keys");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^Note: voice is off here \(RELO_VOICE\): Relo for Mac says nothing of this work; write no --say$/mu);
  assert.doesNotMatch(r.text, /calls this work/u, "no name nudge when nothing is said");
  r = await s.relo("work", "deliver", "--outcome", "Keys rotated");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^Mac says: nothing \(voice is off here\)$/mu);
  assert.doesNotMatch(r.text, /write it for the ear/u);
});
