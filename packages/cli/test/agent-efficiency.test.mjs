import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/args.mjs";
import { progressFraction, shortenText } from "../src/shared/validate.mjs";
import { execute, run } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";
import { EXIT, NetworkError } from "../src/shared/errors.mjs";
import { closest, editDistance } from "../src/suggest.mjs";
import { cardDependencies, fakeCards, fakeHome } from "./fake-cards.mjs";

const session = { CLAUDE_CODE_SESSION_ID: "session-eff-1" };
const topic = ["--topic", "Release 0.7.57"];

async function cli(argv, dependencies, io = {}) {
  const stdout = [];
  const stderr = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), stdoutIsTTY: false, ...io }, dependencies);
  return { exitCode, stdout, stderr, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

/** A fake Relo whose question never gets answered, on a clock that only the waits advance. */
function pendingQuestion(extra = {}) {
  const { client, cards, calls } = fakeCards({ answerAfterPolls: 10_000, ...extra });
  const polls = [];
  const clock = { now: 1_000_000 };
  const base = client.waitForInteraction;
  client.waitForInteraction = async (id, seconds) => {
    polls.push(seconds);
    clock.now += seconds * 1_000;
    return base(id, seconds);
  };
  return { client, cards, calls, polls, deps: (env) => ({ ...cardDependencies(client, { env }), now: () => clock.now }) };
}

test("ask waits 100s inside an agent session and says how to keep waiting", async () => {
  const { polls, deps } = pendingQuestion();
  const out = await cli(["ask", "Ship?", "--approval", ...topic], deps(session));
  assert.equal(out.exitCode, EXIT.TERMINAL);
  assert.equal(polls[0], 100);
  const { error } = out.line;
  assert.equal(error.code, "INTERACTION_TERMINAL");
  assert.equal(error.message, "No answer yet; the question is still open.");
  assert.match(error.hint, /^relo interaction wait int_[0-9a-f-]{36} --timeout 100s$/u);
  assert.equal(error.details.state, "timeout");
  assert.equal(error.details.id, error.hint.split(" ")[3]);
});

test("ask keeps its 5 minute wait outside agent sessions, and --timeout always wins", async () => {
  const outside = pendingQuestion();
  await cli(["ask", "Ship?", "--approval", ...topic], outside.deps({}));
  assert.equal(outside.polls[0], 300);
  const explicit = pendingQuestion();
  await cli(["ask", "Ship?", "--approval", "--timeout", "30s", ...topic], explicit.deps(session));
  assert.equal(explicit.polls[0], 30);
  const longer = pendingQuestion();
  await cli(["ask", "Ship?", "--approval", "--timeout", "4m", ...topic], longer.deps(session));
  assert.equal(longer.polls[0], 240);
});

test("a closed question stays distinct from one that is still open", async () => {
  for (const state of ["expired", "canceled"]) {
    const { client } = fakeCards({ answer: state });
    const out = await cli(["ask", "Ship?", "--approval", ...topic], cardDependencies(client, { env: session }));
    assert.equal(out.exitCode, EXIT.CLOSED);
    assert.equal(out.line.error.details.state, state);
    assert.match(out.line.error.message, /closed .*Do not act/u);
    assert.doesNotMatch(out.line.error.message, /still open/u);
  }
});

test("interaction wait defaults to 100s in an agent session and 60s elsewhere", async () => {
  const waits = [];
  const client = { waitForInteraction: async (id, seconds) => { waits.push(seconds); return { interaction: { id, state: "approved" } }; } };
  await cli(["interaction", "wait", "int_1"], cardDependencies(client, { env: session }));
  await cli(["interaction", "wait", "int_1"], cardDependencies(client));
  await cli(["interaction", "wait", "int_1", "--timeout", "20s"], cardDependencies(client, { env: session }));
  assert.deepEqual(waits, [100, 60, 20]);
});

test("--progress takes 3/5 and 40% as well as 0..1, and rejects the ambiguous", () => {
  assert.equal(progressFraction("3/5"), 0.6);
  assert.equal(progressFraction("0/5"), 0);
  assert.equal(progressFraction("5/5"), 1);
  assert.equal(progressFraction("40%"), 0.4);
  assert.equal(progressFraction("12.5%"), 0.125);
  assert.equal(progressFraction("0.4"), 0.4);
  assert.equal(progressFraction(1), 1);
  assert.equal(progressFraction(null), null);
  for (const bad of ["40", "2", "100", "101", "-1", "6/5", "1/0", "150%", "abc", "1/2/3"]) {
    assert.throws(() => progressFraction(bad), (error) => error.exitCode === EXIT.USAGE && error.details.hint === "Use 0.4, 40% or 2/5", bad);
  }
});

test("shortenText cuts at a word boundary, or hard when there is none", () => {
  assert.equal(shortenText("Short enough", 60), "Short enough");
  const cut = shortenText("Compiling the shared packages and running every integration suite once more", 40);
  assert.ok(Array.from(cut).length <= 40, cut);
  assert.match(cut, /packages and…$/u);
  assert.equal(shortenText("x".repeat(100), 10), `${"x".repeat(9)}…`);
});

test("notify shortens its title and summary, but never a question, topic or label", async () => {
  const sent = [];
  const { client } = fakeCards();
  client.sendNotification = async (body) => { sent.push(body); return { eventId: "ntf_1", delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } }; };
  const deps = cardDependencies(client);
  const out = await cli(["notify", "Done", "--title", "t ".repeat(60), "--summary", "word ".repeat(80), ...topic], deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(out.line.note, "summary shortened to 240 characters; title shortened to 80 characters");
  assert.ok(Array.from(sent[0].title).length <= 80 && Array.from(sent[0].summary).length <= 240);
  const question = await cli(["ask", "q".repeat(121), "--approval", ...topic], deps);
  assert.equal(question.exitCode, EXIT.USAGE);
  assert.match(question.line.error.message, /one line of at most 120 characters/u);
  assert.match(question.line.error.hint, /--detail/u);
  const longTopic = await cli(["activity", "start", "--title", "T", "--status", "S", "--topic", "t".repeat(161)], deps);
  assert.equal(longTopic.exitCode, EXIT.USAGE);
  const label = await cli(["ask", "Ship?", "--approval", "--primary-label", "L".repeat(25), ...topic], deps);
  assert.equal(label.exitCode, EXIT.USAGE);
});

test("edit distance counts a swap as one edit and finds near candidates only", () => {
  assert.equal(editDistance("udpate", "update"), 1);
  assert.equal(editDistance("staus", "status"), 1);
  assert.equal(editDistance("abc", "xyz"), 3);
  assert.equal(closest("staus", ["status", "detail"]), "status");
  assert.equal(closest("zzzzzz", ["status", "detail"]), undefined);
});

test("a mistyped option or command says what was meant", async () => {
  assert.throws(() => parseArgs(["activity", "end", "--staus", "x"]), (error) => error.message === "Unknown option: --staus" && error.details.hint === "Did you mean --status?");
  const far = await cli(["devices", "list", "--wat"], cardDependencies({}));
  assert.equal(far.line.error.hint, "Options for devices list: --page-size");
  const many = await cli(["activity", "end", "--qqqqqqqqqq", "x"], cardDependencies({}));
  assert.equal(many.line.error.hint, "Every flag: relo help all");
  const command = await cli(["activity", "edn", "--status", "x"], cardDependencies({}));
  assert.equal(command.exitCode, EXIT.USAGE);
  assert.equal(command.line.error.message, "Unknown command: activity edn");
  assert.equal(command.line.error.hint, "Did you mean activity end?");
  assert.equal((await cli(["acitivity", "end"], cardDependencies({}))).line.error.hint, "Did you mean activity?");
  assert.equal((await cli(["activity", "frobnicate"], cardDependencies({}))).line.error.hint, "activity takes: end, status, diagnose, get, list");
  assert.match((await cli(["zzzzzzzz"], cardDependencies({}))).line.error.hint, /relo help all/u);
});

test("a typo in the command is reported even when the CLI is not signed in", async () => {
  const deps = { ...cardDependencies({}), loadConfig: async () => { throw new Error("must not read the config"); } };
  const out = await cli(["activity", "udpate"], deps);
  assert.equal(out.line.error.code, "USAGE_ERROR");
});

test("a missing topic is a short message and a hint with only the missing flags", async () => {
  const deps = cardDependencies(fakeCards().client);
  const out = await cli(["notify", "Done", "--title", "x"], deps);
  assert.equal(out.exitCode, EXIT.USAGE);
  assert.equal(out.line.error.message, 'Missing --topic: name the work the way the owner would (e.g. "Release 0.7.57").');
  assert.match(out.line.error.hint, /--topic "<what this work is about>"$/u);
  assert.deepEqual(out.line.error.details.missing, ["topic"]);
  assert.ok(out.stdout[0].length < 330, out.stdout[0]);
  const empty = cardDependencies(fakeCards().client, { identity: {} });
  const all = await cli(["notify", "Done"], empty);
  assert.equal(all.line.error.message, "Missing --source, --project, --topic: name the work the way the owner would (e.g. \"Release 0.7.57\").");
  assert.match(all.line.error.hint, /^relo notify "Done" --source "<your agent, e\.g\. Claude Code>" --project "<repository or product>" --topic /u);
  const generic = await cli(["notify", "Done", "--title", "x", "--topic", "Task"], deps);
  assert.match(generic.line.error.message, /^--topic "Task" is too generic/u);
  assert.doesNotMatch(generic.line.error.message, /Missing/u);
});

function notifyClient() {
  const sent = [];
  const { client, calls } = fakeCards();
  client.sendNotification = async (body) => { sent.push(body); return { eventId: "ntf_1", delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } }; };
  return { client, sent, calls };
}

const undefed = (value) => (value ? "set" : undefined);

test("notify needs a topic outside a session; inside one it names the open work, or the session itself", async () => {
  const outside = notifyClient();
  const first = await cli(["notify", "Shipped"], cardDependencies(outside.client));
  assert.equal(first.exitCode, EXIT.USAGE);
  assert.deepEqual(first.line.error.details.missing, ["topic"]);
  assert.equal(outside.calls.length, 0);
  const idle = notifyClient();
  const second = await cli(["notify", "Shipped"], cardDependencies(idle.client, { env: session }));
  assert.equal(second.exitCode, EXIT.OK);
  assert.equal(idle.sent[0].context.threadName, "Claude Code session", "a standalone message names the session");
  const named = await cli(["notify", "Shipped", "--topic", "Release 0.7.57"], cardDependencies(idle.client, { env: session }));
  assert.equal(named.exitCode, EXIT.OK);
  assert.equal(idle.sent[1].context.threadName, "Release 0.7.57");
});

test("notify with no body reports the body before the identity", async () => {
  const out = await cli(["notify"], cardDependencies(notifyClient().client, { identity: {} }));
  assert.equal(out.exitCode, EXIT.USAGE);
  assert.match(out.line.error.message, /Notification body is required/u);
});

const fullDevices = (n) => Array.from({ length: n }, (_, i) => ({
  id: `act_${i}`, state: "active", title: `Card ${i}`, status: "Applying migrations", detail: "x".repeat(200), progress: i === 0 ? null : 0.5,
  updatedAt: "2026-01-01T00:00:00Z", sequence: i, context: { providerName: "Claude Code" }, presentation: { components: [] },
}));

test("activity list is compact and defaults to the newest 10", async () => {
  const client = { listActivities: async () => ({ activities: fullDevices(25) }) };
  const out = await cli(["activity", "list"], cardDependencies(client));
  assert.equal(out.line.cards.length, 10);
  assert.deepEqual(out.line.cards[0], { id: "act_0", state: "active", title: "Card 0", status: "Applying migrations", updatedAt: "2026-01-01T00:00:00Z" });
  assert.equal(out.line.cards[1].progress, 0.5);
  assert.ok(out.stdout[0].length < 2_000, `${out.stdout[0].length}`);
  assert.equal((await cli(["activity", "list", "--limit", "3"], cardDependencies(client))).line.cards.length, 3);
  const full = await cli(["activity", "list", "--full"], cardDependencies(client));
  assert.equal(full.line.command, "activity.list");
  assert.equal(full.line.data.activities.length, 10);
});

function doctorClient({ scopes, readyError } = {}) {
  return {
    ready: async () => { if (readyError) throw readyError; return { ready: true }; },
    authStatus: async () => ({ authenticated: true, credential: { id: "cred_1", clientName: "Studio", prefix: "rlo_x", scopes: scopes ?? ["activities:read", "activities:write", "devices:read", "interactions:create", "interactions:read", "notifications:send", "services:read"], expiresAt: "2027-01-01T00:00:00Z" } }),
    doctor: async () => ({ version: 1, ok: true }),
    listDevices: async () => ({ hasMore: false, cursor: null, devices: [{ deviceId: PHONE, liveActivityAuthorization: "authorized" }] }),
  };
}
const PHONE = "dev_abcdefghijkl";
/** A signed-in config that already passed the phone test. */
const verifiedConfig = async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), phoneTest: { verifiedAt: "2026-01-01T00:00:00Z", deviceId: PHONE } });

test("doctor prints {ok:true} when healthy and only the failing checks otherwise", async () => {
  const home = await fakeHome({ block: true, skillVersion: VERSION, agents: [".claude"] });
  const withHome = (client) => ({ ...cardDependencies(client), home, loadConfig: verifiedConfig });
  const healthy = await cli(["doctor"], withHome(doctorClient()));
  assert.equal(healthy.exitCode, EXIT.OK);
  assert.deepEqual(healthy.line, { ok: true, ready: true });
  const down = await cli(["doctor"], withHome(doctorClient({ readyError: new NetworkError("offline") })));
  assert.equal(down.exitCode, EXIT.NETWORK);
  assert.equal(down.line.ok, false);
  assert.deepEqual(Object.keys(down.line.checks), ["server"]);
  assert.match(down.line.checks.server.hint, /RELO_API_URL/u);
  const full = await cli(["doctor", "--full"], withHome(doctorClient()));
  assert.deepEqual(Object.keys(full.line.data.checks), ["localConfig", "server", "auth", "runtime"]);
});

test("auth status is one short line; scopes appear only when one is missing", async () => {
  const ok = await cli(["auth", "status"], cardDependencies(doctorClient()));
  assert.deepEqual(ok.line, { ok: true, signedIn: true, server: "https://relo.example", client: "Studio", expiresAt: "2027-01-01T00:00:00Z" });
  const narrow = await cli(["auth", "status"], cardDependencies(doctorClient({ scopes: ["activities:read"] })));
  assert.ok(narrow.line.missingScopes.includes("devices:read"));
  assert.equal(narrow.line.scopes, undefined);
  assert.match(narrow.line.hint, /relo auth login/u);
  const full = await cli(["auth", "status", "--full"], cardDependencies(doctorClient()));
  assert.ok(full.line.data.credential.scopes.length > 0);
});

test("devices list keeps only id, name, liveActivities and lastSeenAt", async () => {
  const client = { listDevices: async () => ({ hasMore: false, cursor: null, devices: [
    { deviceId: "dev_abcdefghijkl", name: "Phone", installationId: "i", model: "m", liveActivityAuthorization: "authorized", lastSeenAt: "2026-02-02T00:00:00Z" },
    { deviceId: "dev_mnopqrstuvwx", name: "Spare", liveActivityAuthorization: "denied", lastSeenAt: null },
  ] }) };
  const out = await cli(["devices", "list"], cardDependencies(client));
  assert.deepEqual(out.line, { ok: true, devices: [
    { id: "dev_abcdefghijkl", name: "Phone", liveActivities: true, lastSeenAt: "2026-02-02T00:00:00Z" },
    { id: "dev_mnopqrstuvwx", name: "Spare", liveActivities: false },
  ] });
});

test("ask sends the question as one line and the explanation as --detail", async () => {
  const { client, calls } = fakeCards({ answer: "approved", answerAfterPolls: 1 });
  const deps = cardDependencies(client);
  const detail = "**Why:** rewrites 2 tables.\n- Undo: relo rollback";
  const out = await cli(["ask", "Run the migration now?", "--approval", "--detail", detail, ...topic], deps);
  assert.equal(out.exitCode, EXIT.OK);
  const asked = calls.find((call) => ["ask", "question"].includes(call.op));
  assert.equal(asked.body.prompt, "Run the migration now?");
  assert.equal(asked.body.detail, detail);

  const twoLines = await cli(["ask", "Ship?\nNow", "--approval", ...topic], deps);
  assert.equal(twoLines.exitCode, EXIT.USAGE);
  const tooMuch = await cli(["ask", "Ship?", "--approval", "--detail", "d".repeat(4_001), ...topic], deps);
  assert.equal(tooMuch.exitCode, EXIT.USAGE);

  const piped = cardDependencies(client);
  piped.readStdinJson = async () => ({ prompt: "Ship 1.2?", detail: "Changelog:\n- one\n- two" });
  const fromStdin = await cli(["ask", "--approval", "--stdin", ...topic], piped);
  assert.equal(fromStdin.exitCode, EXIT.OK);
  assert.equal(calls.filter((call) => ["ask", "question"].includes(call.op)).at(-1).body.detail, "Changelog:\n- one\n- two");
});

test("ask --option offers 2-4 choices and reports the one picked", async () => {
  const { client, calls } = fakeCards({ answer: "replied", response: { optionId: "roll-back", label: "Roll back" } });
  const deps = cardDependencies(client);
  const out = await cli(["ask", "Which release?", "--option", "Ship", "--option", "v2=Version 2", "--option", "Roll back",
    "--detail", "Ship is 1.4; Version 2 needs the migration.", ...topic], deps);
  assert.equal(out.exitCode, EXIT.OK);
  const asked = calls.find((call) => ["ask", "question"].includes(call.op)).body;
  assert.equal(asked.type, "choice");
  assert.deepEqual(asked.options, [{ id: "ship", label: "Ship" }, { id: "v2", label: "Version 2" }, { id: "roll-back", label: "Roll back" }]);
  assert.equal(asked.primaryLabel, undefined);
  assert.equal(out.line.state, "chosen");
  assert.equal(out.line.option, "roll-back");
  assert.equal(out.line.label, "Roll back");

  for (const args of [
    ["--option", "Only"],
    ["--option", "A", "--option", "B", "--option", "C", "--option", "D", "--option", "E"],
    ["--option", "Same", "--option", "same"],
    ["--option", "A", "--option", "B", "--approval"],
    ["--option", "A", "--option", "B", "--primary-label", "Go"],
    ["--option", "A", "--option", "This label is far longer than a button"],
    ["--option", "!!!", "--option", "B"],
  ]) {
    const refused = await cli(["ask", "Which?", ...args, ...topic], deps);
    assert.equal(refused.exitCode, EXIT.USAGE, args.join(" "));
  }

  const piped = cardDependencies(client);
  piped.readStdinJson = async () => ({ prompt: "Which?", options: ["Ship", { id: "wait", label: "Hold" }] });
  assert.equal((await cli(["ask", "--stdin", ...topic], piped)).exitCode, EXIT.OK);
  assert.deepEqual(calls.filter((call) => ["ask", "question"].includes(call.op)).at(-1).body.options, [{ id: "ship", label: "Ship" }, { id: "wait", label: "Hold" }]);
});

test("inside a session, notify names the session's open work", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { detectCaller } = await import("../src/caller.mjs");
  const { writeSession } = await import("../src/agent/session-file.mjs");
  const state = mkdtempSync(join(tmpdir(), "relo-notify-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const env = { ...session, XDG_STATE_HOME: state };
  const { client, sent } = notifyClient();
  const deps = cardDependencies(client, { env });
  assert.ok(await writeSession(detectCaller(env), { env }, { open: { id: "wrk_1", lifecycle: "open", goal: "Release 0.7.57", card: { id: "act_missing", state: "active" } }, parked: [] }));
  const out = await cli(["notify", "Shipped"], deps);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out.line));
  assert.equal(sent[0].context.threadName, "Release 0.7.57");
});
