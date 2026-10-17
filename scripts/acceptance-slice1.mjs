// Slice 1 acceptance flows (STATE-SPEC §9), run by scripts/acceptance-slice1.sh against a LOCAL server.
// Each step runs the real CLI from the checkout as a given caller type and asserts the echo and /api/now.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.RELO_ACCEPT_API_URL;
const TOKEN = process.env.RELO_ACCEPT_TOKEN;
const STATE = process.env.RELO_ACCEPT_STATE;
if (!API || !TOKEN || !STATE || !/^http:\/\/127\.0\.0\.1:/u.test(API)) throw new Error("run through scripts/acceptance-slice1.sh (local server only)");
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "bin", "relo.mjs");
mkdirSync(join(STATE, "home"), { recursive: true });

const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX_|RELO_|GEMINI_CLI|OPENCODE|CURSOR_AGENT)/u.test(key)));
function relo(caller, ...argv) {
  const env = { ...base, ...caller, RELO_API_URL: API, RELO_TOKEN: TOKEN, XDG_STATE_HOME: STATE, HOME: join(STATE, "home") };
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...argv], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}
const ok = (r, label) => { assert.equal(r.code, 0, `${label}\n${r.out}`); return r.out; };
const refused = (r, code, label) => {
  assert.notEqual(r.code, 0, `${label} should be refused\n${r.out}`);
  if (code) assert.match(r.out, new RegExp(code, "u"), label);
  return r.out;
};
async function now() {
  const response = await fetch(`${API}/api/now`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 200, `GET /api/now ${response.status}`);
  return response.json();
}
const BUCKETS = ["needsYou", "recent", "waitingOnYou", "running", "quiet", "paused"];
const item = (summary, title) => BUCKETS.flatMap((b) => summary[b] ?? []).filter((i) => i.title === title).at(-1);
const ownerState = (i) => i?.owner?.state ?? i?.owner?.kind ?? i?.owner;
let passed = 0;
const failed = [];
async function scenario(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`not ok - ${name}\n  ${String(error.message).split("\n").join("\n  ")}`);
  }
}

const A = { CLAUDE_CODE_SESSION_ID: "accept-session-a" };
const B = { CLAUDE_CODE_SESSION_ID: "accept-session-b" };
const C = { CLAUDE_CODE_SESSION_ID: "accept-session-c" };
const D = { CLAUDE_CODE_SESSION_ID: "accept-session-d" };

await scenario("§9.1 short task: start → update → finish shows Moving then Done", async () => {
  ok(relo(A, "work", "start", "--goal", "Fix the login crash", "--status", "Reading the stack trace"), "start");
  assert.equal(ownerState(item(await now(), "Fix the login crash")), "moving");
  ok(relo(A, "work", "update", "--status", "Writing the fix"), "update");
  const done = ok(relo(A, "work", "finish", "--outcome", "Login fixed and tested"), "finish");
  assert.match(done, /\(finished, done\)/u);
  assert.equal(ownerState(item(await now(), "Fix the login crash")), "done");
});

await scenario("§9.2 plan grows: start 2 steps → --add → --plan revise → step count → finish, one work, no restart", async () => {
  const start = ok(relo(A, "work", "start", "--goal", "Release 0.18", "--plan", "Build the server,Install iPhone 0.10.0 (owner, later)"), "start");
  assert.match(start, /\[ \] s2 Install iPhone 0\.10\.0 \(owner, later\)/u, "DOGFOOD #15: comma inside brackets stays one step");
  const id = /Work (wrk_[0-9a-f]{8})/u.exec(start)[1];
  ok(relo(A, "work", "update", "--next-step"), "next");
  ok(relo(A, "work", "update", "--add", "Run the tests,Tag the release"), "add");
  const revised = ok(relo(A, "work", "update", "--plan", "Run the tests,Tag the release,Write release notes"), "revise");
  assert.match(revised, /1 skipped: s2/u, "DOGFOOD #16: skipped folded");
  const counted = ok(relo(A, "work", "update", "--progress", "3/9"), "count");
  assert.match(counted, /\(3\/9\)/u);
  const state = ok(relo(A, "work", "state"), "DOGFOOD #11: relo work state");
  assert.match(state, new RegExp(id, "u"), "same work throughout");
  ok(relo(A, "work", "finish", "--outcome", "0.18 released"), "finish");
});

await scenario("§9.3 new topic: start --new parks the old work", async () => {
  ok(relo(C, "work", "start", "--goal", "Migrate the billing tables"), "first");
  const switched = ok(relo(C, "work", "start", "--new", "--goal", "Answer the support ticket"), "new");
  assert.match(switched, /Parked: wrk_/u);
  const summary = await now();
  assert.equal(ownerState(item(summary, "Migrate the billing tables")), "paused");
  assert.equal(ownerState(item(summary, "Answer the support ticket")), "moving");
});

await scenario("§9.13/14 sessions isolated: B cannot read, update or finish A's work; owner-only refused", async () => {
  const start = ok(relo(A, "work", "start", "--goal", "Rotate the signing keys"), "A start");
  const id = /Work (wrk_[0-9a-f]{8})/u.exec(start)[1];
  const bState = ok(relo(B, "state", "--sync"), "B state");
  assert.doesNotMatch(bState, /Rotate the signing keys/u);
  refused(relo(B, "work", "update", "--status", "Hijacking"), "no open work", "B update");
  refused(relo(B, "work", "finish", "--work", id, "--outcome", "Hijacked"), "no work", "B finish A's work");
  refused(relo(B, "work", "resume", id), "no work", "B resume A's work");
  for (const argv of [["sessions"], ["activity", "list"], ["listen"]]) refused(relo(B, ...argv), "owner", `B ${argv.join(" ")}`);
  const aState = ok(relo(A, "state", "--sync"), "A state");
  assert.match(aState, /Rotate the signing keys/u, "A's work untouched");
  ok(relo(A, "work", "finish", "--outcome", "Keys rotated"), "A finish");
});

await scenario("§9.7 question unanswered stays Needs you; ask in a session attaches to the open work", async () => {
  ok(relo(D, "work", "start", "--goal", "Deploy the API"), "start");
  const asked = relo(D, "ask", "Deploy to production?", "--approval", "--timeout", "1s");
  assert.ok([0, 4, 5, 7, 8].includes(asked.code), `ask exit ${asked.code}\n${asked.out}`);
  const deploy = item(await now(), "Deploy the API");
  assert.ok(deploy?.question, `question attached to the work: ${JSON.stringify(deploy)}`);
  assert.equal(ownerState(deploy), "needs_you");
});

await scenario("no-hooks session shows last seen from its own relo commands", async () => {
  const summary = await now();
  const rows = summary.sessions?.sessions ?? [];
  assert.ok(rows.length > 0, "hookless sessions are listed");
  for (const row of rows) { assert.equal(row.observed, false); assert.ok(row.lastSeenAt, "last seen from relo commands"); }
});

await scenario("script surface: relo work needs a producer key for a script", async () => {
  refused(relo({}, "work", "start", "--goal", "Nightly backup"), "NOT_AVAILABLE|not available|PRODUCER_REQUIRED|--producer", "script work");
});

console.log(`${passed} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
