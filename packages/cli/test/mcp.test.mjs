import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { cardKey } from "../src/messages/card-context.mjs";
import { SUPPORTED_PROTOCOLS, TOOLS, TOOL_SPECS, serveMcp, sourceFromClient, toolArgv, validateArguments } from "../src/agent/mcp.mjs";
import { cardDependencies, fakeCards } from "./fake-cards.mjs";

const box = mkdtempSync(join(tmpdir(), "relo-mcp-"));
test.after(() => rmSync(box, { recursive: true, force: true }));
const project = join(box, "proj");
mkdirSync(join(project, ".git"), { recursive: true });

const DELIVERY = { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 };

/** An in-process MCP client over a pair of pipes, talking to the real server code and a fake Relo. */
function connect({ client, env = {}, interval = 20 } = {}) {
  const fake = client ? { client } : fakeCards();
  const base = fake.client;
  base.sendNotification ??= async (body) => { fake.sent = body; return { eventId: "ntf_1", delivery: DELIVERY }; };
  base.ready ??= async () => ({ ready: true });
  base.authStatus ??= async () => ({ authenticated: true, credential: { id: "cred_1", clientName: "t", prefix: "rl_", scopes: ["activities:write", "devices:read"] } });
  base.doctor ??= async () => ({ version: 1, ok: true });
  // /api/session/works as contracts/works.ts shapes it, one store per session key.
  fake.works ??= [];
  fake.sessionKeys ??= new Set();
  base.sessionRequest ??= async (method, path, { body, sessionKey }) => {
    fake.sessionKeys.add(sessionKey);
    const mine = fake.works.filter((w) => w.sessionKey === sessionKey);
    const view = (w) => ({ ...w, sessionKey: undefined });
    const state = () => ({ open: mine.find((w) => w.lifecycle === "open") ?? null, parked: mine.filter((w) => w.lifecycle === "paused") });
    if (method === "GET") return state();
    if (path === "/api/session/works") {
      const delivered = mine.find((w) => w.lifecycle === "open" && w.plan.rounds?.at(-1)?.state === "closed");
      if (delivered && body.round) {
        const n = delivered.plan.rounds.length + 1;
        const added = (body.plan?.steps ?? []).map((step, i) => ({ id: `s${delivered.plan.next + i}`, label: step.label, state: i === 0 ? "current" : "open", addedIn: 2, round: n }));
        delivered.plan = { ...delivered.plan, next: delivered.plan.next + added.length, steps: [...delivered.plan.steps, ...added], rounds: [...delivered.plan.rounds, { n, state: "open", title: body.round.readable }] };
        delivered.version += 1;
        return { work: view(delivered), disposition: "round_opened", parked: [], replayed: false, ignored: [] };
      }
      const steps = (body.plan?.steps ?? []).map((step, i) => ({ id: `s${i + 1}`, label: step.label, state: i === 0 ? "current" : "open", addedIn: 1 }));
      const work = { id: `wrk_${String(fake.works.length + 1).padStart(8, "0")}`, sessionKey, lifecycle: "open", version: 1, goal: body.goal.readable,
        status: body.status?.readable ?? null, plan: { version: 1, next: steps.length + 1, complete: false, steps }, progress: body.progress ?? null };
      fake.works.push(work);
      return { work: view(work), disposition: "started", parked: [], replayed: false, ignored: [] };
    }
    const work = mine.find((w) => path.includes(w.id));
    if (!work) throw Object.assign(new Error("Work not found in this session."), { status: 404 });
    if (path.endsWith("/deliver")) {
      work.plan = { ...work.plan, steps: work.plan.steps.map((step) => ({ ...step, round: 1, state: step.state === "current" ? "done" : step.state === "open" ? "skipped" : step.state })), rounds: [{ n: 1, state: "closed", outcome: body.outcome.readable }] };
      work.version += 1;
      return { work: view(work), disposition: "delivered", parked: [], replayed: false, ignored: [] };
    }
    if (path.endsWith("/finish")) Object.assign(work, { lifecycle: "finished", result: body.result, outcome: body.outcome.readable });
    else if (body?.plan?.op === "next") {
      const current = work.plan.steps.find((step) => step.state === "current");
      if (current) current.state = "done";
      const following = work.plan.steps.find((step) => step.state === "open");
      if (following) following.state = "current";
    }
    if (body?.status) work.status = body.status.readable;
    work.version += 1;
    return { work: view(work), disposition: work.lifecycle === "finished" ? "finished" : "updated", parked: [], replayed: false, ignored: [] };
  };
  base.cancelInteraction ??= async (id) => { (fake.canceled ??= []).push(id); return {}; };
  const { identityDefaults: _drop, ...dependencies } = cardDependencies(base);
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  const waiting = new Set();
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const message = JSON.parse(line); // stdout purity: every line is JSON...
      assert.equal(message.jsonrpc, "2.0"); // ...and a JSON-RPC message
      messages.push(message);
      for (const check of waiting) check();
    }
  });
  const done = serveMcp({ input, output, run, version: "0.10.0", env, progressIntervalMs: interval,
    overrides: { ...dependencies, originDefaults: () => ({}), home: box, cwd: project } });
  const until = (predicate) => new Promise((resolve) => {
    const check = () => { const found = messages.find(predicate); if (found) { waiting.delete(check); resolve(found); } };
    waiting.add(check);
    check();
  });
  let next = 0;
  const api = {
    fake, messages, done,
    notify: (method, params) => input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
    request(method, params, id = ++next) {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return until((message) => message.id === id);
    },
    until,
    async call(name, args, extra = {}) {
      const response = await api.request("tools/call", { name, arguments: args, ...extra });
      assert.ok(!response.error, JSON.stringify(response.error));
      return { ...response.result, json: JSON.parse(response.result.content[0].text) };
    },
    async initialize(name = "claude-code") {
      const response = await api.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } });
      api.notify("notifications/initialized");
      return response;
    },
    async close() { input.end(); await done; },
  };
  return api;
}

const topic = { topic: "Release 0.7.57" };

test("initialize echoes a supported protocol version and otherwise offers the latest", async () => {
  const mcp = connect();
  const first = await mcp.initialize();
  assert.equal(first.result.protocolVersion, "2025-06-18");
  assert.equal(first.result.serverInfo.name, "relo");
  assert.deepEqual(first.result.capabilities, { tools: { listChanged: false } });
  const other = await mcp.request("initialize", { protocolVersion: "1999-01-01", clientInfo: { name: "x" } });
  assert.equal(other.result.protocolVersion, SUPPORTED_PROTOCOLS[0]);
  assert.deepEqual((await mcp.request("ping")).result, {});
  assert.equal((await mcp.request("server/discover", {})).error.code, -32601, "dual-era clients fall back to initialize");
  assert.equal((await mcp.request("resources/list")).error.code, -32601);
  await mcp.close();
});

test("tools/list names the ten tools, carries the rules and marks the annotations", async () => {
  const mcp = connect();
  await mcp.initialize();
  const { tools } = (await mcp.request("tools/list")).result;
  assert.deepEqual(tools.map((tool) => tool.name), ["relo_work_start", "relo_work_update", "relo_work_deliver", "relo_work_handoff", "relo_work_finish", "relo_work_state", "relo_ask", "relo_interaction_wait", "relo_notify", "relo_doctor"]);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.relo_doctor.annotations.readOnlyHint, true);
  for (const name of ["relo_work_finish", "relo_notify"]) assert.equal(byName[name].annotations.destructiveHint, false);
  assert.equal(byName.relo_work_state.annotations.readOnlyHint, true);
  assert.match(byName.relo_ask.description, /Only an `approval` question that returns state `approved` is permission/u);
  assert.match(byName.relo_notify.description, /rarely/u);
  assert.match(byName.relo_work_start.description, /secrets/u);
  assert.deepEqual(byName.relo_ask.inputSchema.properties.kind.enum, ["approval", "yes_no"]);
  // deliver closes a round, finish ends the goal; start takes a round; nesting is by indentation in plan entries
  assert.match(byName.relo_work_deliver.description, /when the work is done and nothing is left, use relo_work_finish/u);
  assert.match(byName.relo_work_finish.description, /relo_work_deliver instead/u);
  assert.deepEqual(byName.relo_work_deliver.inputSchema.required, ["outcome"]);
  assert.equal(byName.relo_work_deliver.inputSchema.properties.outcome.type, "string");
  assert.equal(byName.relo_work_start.inputSchema.properties.round.type, "string");
  assert.equal(byName.relo_work_start.inputSchema.required, undefined, "a round needs no goal");
  // handoff: the note is required; start takes the handle of a waiting handoff in place of a goal
  assert.deepEqual(byName.relo_work_handoff.inputSchema.required, ["next"]);
  assert.equal(byName.relo_work_handoff.inputSchema.properties.next.type, "string");
  assert.equal(byName.relo_work_start.inputSchema.properties.from.type, "string");
  assert.match(byName.relo_work_handoff.description, /no longer owns the work/u);
  assert.match(byName.relo_work_start.inputSchema.properties.plan.description, /indent/u);
  assert.equal(byName.relo_work_update.inputSchema.properties.under.type, "string");
  assert.equal(byName.relo_work_update.inputSchema.properties.detail.type, "string");
  assert.deepEqual(TOOLS.map((tool) => tool.name), tools.map((tool) => tool.name));
  await mcp.close();
});

test("every tool round-trips against a fake Relo, as one session per connection", async () => {
  const mcp = connect();
  await mcp.initialize("claude-code");
  const started = await mcp.call("relo_work_start", { goal: "Deploy 0.7.57", status: "Building the image", plan: ["Build image", "Run tests", "Go live"] });
  assert.equal(started.isError, false, JSON.stringify(started.json));
  assert.equal(started.json.ok, true);
  assert.equal(started.json.disposition, "started");
  assert.match(started.json.echo, /Deploy 0\.57|Deploy 0\.7\.57/u);
  const updated = await mcp.call("relo_work_update", { status: "Running the suite", next_step: true });
  assert.equal(updated.isError, false, JSON.stringify(updated.json));
  assert.equal(updated.json.work.step, "2/3");
  const state = await mcp.call("relo_work_state", {});
  assert.equal(state.isError, false, JSON.stringify(state.json));
  assert.equal(state.json.work.id, started.json.work.id);
  const asked = await mcp.call("relo_ask", { question: "Deploy 0.7.57 to production?", kind: "approval" });
  assert.equal(asked.isError, false, JSON.stringify(asked.json));
  const notified = await mcp.call("relo_notify", { body: "0.7.57 is live", title: "Deployed" });
  assert.equal(notified.isError, false, JSON.stringify(notified.json));
  const finished = await mcp.call("relo_work_finish", { outcome: "0.7.57 live on production" });
  assert.equal(finished.isError, false, JSON.stringify(finished.json));
  assert.equal(finished.json.disposition, "finished");
  const doctor = await mcp.call("relo_doctor", {});
  assert.equal(typeof doctor.json.ok, "boolean");
  assert.equal(mcp.fake.sessionKeys.size, 1, "one session for the connection");
  assert.equal(mcp.fake.sent.title, "Deployed");
  await mcp.close();
});

test("deliver closes the round and the work stays open; start with a round opens the next one; plan lines nest by indentation", async () => {
  const mcp = connect();
  await mcp.initialize("claude-code");
  const started = await mcp.call("relo_work_start", { goal: "Add dark mode", plan: ["Design the tokens", "Build the toggle", "  Wire it to settings"] });
  assert.equal(started.isError, false, JSON.stringify(started.json));
  const argv = toolArgv(TOOL_SPECS.find((spec) => spec.name === "relo_work_start"), { goal: "G", plan: ["A", "  B"] });
  assert.ok(argv.includes("--plan=A\n  B"), "indented plan lines are a newline list, which relo work nests");
  assert.ok(toolArgv(TOOL_SPECS.find((spec) => spec.name === "relo_work_start"), { goal: "G", plan: ["A", "B"] }).includes("--plan=A,B"), "plain ones stay comma-separated");
  // Open top-level steps refuse a deliver (the plan belongs to the goal); drop_rest closes the round anyway.
  const premature = await mcp.call("relo_work_deliver", { outcome: "Design tokens done" });
  assert.equal(premature.isError, true, JSON.stringify(premature.json));
  assert.match(JSON.stringify(premature.json), /REFUSED_OPEN_STEPS/u);
  assert.match(JSON.stringify(premature.json), /open steps: s2 Build the toggle/u);
  assert.match(JSON.stringify(premature.json), /relo ask/u);
  assert.match(JSON.stringify(premature.json), /--drop-rest/u);
  const deliverTool = TOOLS.find((tool) => tool.name === "relo_work_deliver");
  assert.equal(deliverTool.inputSchema.properties.drop_rest.type, "boolean");
  assert.deepEqual(toolArgv(TOOL_SPECS.find((spec) => spec.name === "relo_work_deliver"), { outcome: "x", drop_rest: true }).slice(-2), ["--outcome=x", "--drop-rest"]);
  const delivered = await mcp.call("relo_work_deliver", { outcome: "Dark mode ships behind the toggle", drop_rest: true });
  assert.equal(delivered.isError, false, JSON.stringify(delivered.json));
  assert.match(delivered.json.echo, /Note: skipped 1 open step \(--drop-rest\): s2 Build the toggle/u);
  assert.equal(delivered.json.disposition, "delivered");
  assert.equal(delivered.json.work.lifecycle, "open");
  assert.match(delivered.json.echo, /Owner sees: the round's final card and one quiet notification: "Dark mode ships behind the toggle"; then it's the owner's turn/u);
  const refused = await mcp.call("relo_work_start", { goal: "Add dark mode" });
  assert.equal(refused.isError, true, "a delivered work needs a round");
  assert.match(JSON.stringify(refused.json), /--round/u);
  const round = await mcp.call("relo_work_start", { round: "Follow the system theme", plan: ["Read the system setting"] });
  assert.equal(round.isError, false, JSON.stringify(round.json));
  assert.equal(round.json.disposition, "round_opened");
  assert.match(round.json.echo, /Round 2 "Follow the system theme"/u);
  await mcp.close();
});

test("two connections are two sessions", async () => {
  const a = connect();
  const b = connect({ client: a.fake.client });
  b.fake.works = a.fake.works;
  await a.initialize("claude-ai");
  await b.initialize("claude-ai");
  await a.call("relo_work_start", { goal: "Deploy 0.7.57" });
  await b.call("relo_work_start", { goal: "Deploy 0.7.57" });
  assert.equal(a.fake.sessionKeys.size, 2);
  await Promise.all([a.close(), b.close()]);
});

test("client names map to source names", () => {
  assert.equal(sourceFromClient("claude-code"), "Claude Code");
  assert.equal(sourceFromClient("claude-ai"), "Claude");
  assert.equal(sourceFromClient("cursor-vscode"), "Cursor");
  assert.equal(sourceFromClient("codex-mcp-client"), "Codex");
  assert.equal(sourceFromClient("gemini-cli-mcp-client"), "Gemini CLI");
  assert.equal(sourceFromClient("antigravity"), "Antigravity");
  assert.equal(sourceFromClient("Some Tool"), "Some Tool");
  assert.equal(sourceFromClient(undefined), undefined);
});

test("errors come back as isError with the compact error line; bad arguments never reach the CLI", async () => {
  const mcp = connect();
  await mcp.initialize();
  const empty = await mcp.call("relo_work_update", { status: "Running the suite" });
  assert.equal(empty.isError, true, "no open work");
  const missing = await mcp.call("relo_work_finish", {});
  assert.equal(missing.isError, true);
  assert.match(missing.json?.error?.message ?? JSON.stringify(missing), /outcome/u);
  const bad = await mcp.call("relo_ask", { question: "Q", kind: "maybe" });
  assert.equal(bad.isError, true);
  assert.match(bad.json.error.message, /kind must be one of/u);
  assert.equal((await mcp.call("relo_work_finish", { surprise: 1 })).isError, true);
  assert.equal((await mcp.request("tools/call", { name: "nope", arguments: {} })).error.code, -32602);
  assert.equal(mcp.fake.calls.length, 0, "no card call was made");
  await mcp.close();
});

test("a denial is an answer, not a tool failure; a closed question is an error", async () => {
  const denied = connect({ client: fakeCards({ answer: "denied" }).client });
  await denied.initialize();
  const no = await denied.call("relo_ask", { question: "Deploy?", kind: "approval", ...topic });
  assert.equal(no.isError, false);
  assert.match(JSON.stringify(no.json), /denied/u);
  await denied.close();
  const expired = connect({ client: fakeCards({ answer: "expired" }).client });
  await expired.initialize();
  const gone = await expired.call("relo_ask", { question: "Deploy?", kind: "approval", ...topic });
  assert.equal(gone.isError, true);
  assert.match(JSON.stringify(gone.json), /expired/u);
  await expired.close();
});

/** A fake whose question stays pending for `polls` slices of 30 ms. */
function slowAnswer({ polls, answer = "approved" }) {
  const fake = fakeCards({ answer });
  const waitOnce = fake.client.waitForInteraction;
  let seen = 0;
  fake.client.waitForInteraction = async (id, seconds) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    seen += 1;
    if (seen < polls) return { interaction: { id, state: "pending" } };
    return waitOnce(id, seconds);
  };
  return fake;
}

test("ask waits with progress notifications when the client gave a progressToken", async () => {
  const mcp = connect({ client: slowAnswer({ polls: 5 }).client, interval: 10 });
  await mcp.initialize();
  const response = await mcp.request("tools/call", { name: "relo_ask", arguments: { question: "Ship it?", kind: "yes_no", ...topic }, _meta: { progressToken: "tok-1" } });
  assert.equal(response.result.isError, false);
  assert.match(response.result.content[0].text, /"state":"approved"|yes/u);
  const progress = mcp.messages.filter((message) => message.method === "notifications/progress");
  assert.ok(progress.length >= 3, `progress notifications: ${progress.length}`);
  assert.ok(progress.every((message) => message.params.progressToken === "tok-1"));
  const values = progress.map((message) => message.params.progress);
  assert.deepEqual(values, [...values].sort((a, b) => a - b));
  assert.equal(new Set(values).size, values.length, "progress strictly increases");
  assert.ok(mcp.messages.indexOf(progress.at(-1)) < mcp.messages.indexOf(response), "progress comes before the result");
  await mcp.close();
});

test("without a progressToken no progress is sent", async () => {
  const mcp = connect({ client: slowAnswer({ polls: 3 }).client, interval: 10 });
  await mcp.initialize();
  await mcp.call("relo_ask", { question: "Ship it?", kind: "yes_no", ...topic });
  assert.equal(mcp.messages.filter((message) => message.method === "notifications/progress").length, 0);
  await mcp.close();
});

test("notifications/cancelled stops the wait, sends no response and closes the question", async () => {
  const fake = slowAnswer({ polls: 10_000 });
  const mcp = connect({ client: fake.client, interval: 10 });
  await mcp.initialize();
  const id = 77;
  mcp.request("tools/call", { name: "relo_ask", arguments: { question: "Ship it?", kind: "approval", ...topic }, _meta: { progressToken: 9 } }, id);
  await mcp.until((message) => message.method === "notifications/progress");
  mcp.notify("notifications/cancelled", { requestId: id, reason: "user stopped" });
  const pong = await mcp.request("ping");
  assert.deepEqual(pong.result, {});
  await mcp.close();
  assert.equal(mcp.messages.some((message) => message.id === id), false, "a cancelled request gets no response");
  assert.equal(mcp.fake.canceled?.length, 1, "nobody is waiting any more, so the question is closed");
});

test("the cancelled question is canceled on the server", async () => {
  const fake = slowAnswer({ polls: 10_000 });
  fake.client.cancelInteraction = async (id) => { (fake.canceled ??= []).push(id); return {}; };
  const mcp = connect({ client: fake.client, interval: 10 });
  await mcp.initialize();
  mcp.request("tools/call", { name: "relo_ask", arguments: { question: "Ship it?", kind: "approval", ...topic }, _meta: { progressToken: 1 } }, 5);
  await mcp.until((message) => message.method === "notifications/progress");
  mcp.notify("notifications/cancelled", { requestId: 5 });
  await mcp.request("ping");
  await mcp.close();
  assert.equal(fake.canceled?.length, 1);
  assert.match(fake.canceled[0], /^int_/u);
});

test("closing the input ends a wait in flight without a response", async () => {
  const mcp = connect({ client: slowAnswer({ polls: 10_000 }).client, interval: 10 });
  await mcp.initialize();
  mcp.request("tools/call", { name: "relo_ask", arguments: { question: "Ship it?", kind: "approval", ...topic }, _meta: { progressToken: 1 } }, 3);
  await mcp.until((message) => message.method === "notifications/progress");
  await mcp.close();
  assert.equal(mcp.messages.some((message) => message.id === 3), false);
});

test("argument validation", () => {
  const schema = TOOLS.find((tool) => tool.name === "relo_ask").inputSchema;
  assert.equal(validateArguments(schema, { question: "Q", kind: "approval" }), undefined);
  assert.match(validateArguments(schema, { kind: "approval" }), /question is required/u);
  assert.match(validateArguments(schema, { question: "Q", kind: "approval", timeout_seconds: 900 }), /at most 300/u);
  assert.match(validateArguments(schema, { question: 5, kind: "approval" }), /must be string/u);
  assert.match(validateArguments(schema, [], "x"), /object/u);
});

test("a real `relo mcp` process writes only protocol messages to stdout", async () => {
  const home = join(box, "real-home");
  mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "bin", "relo.mjs"), "mcp"], {
    cwd: project,
    env: { PATH: process.env.PATH, HOME: home, RELO_CONFIG_PATH: join(home, "none.json"), RELO_NO_UPDATE_CHECK: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "claude-code" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  send({ id: 3, method: "tools/call", params: { name: "relo_doctor", arguments: {} } });
  send({ id: 4, method: "tools/call", params: { name: "relo_card_start", arguments: { title: "T", status: "S" } } });
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  const lines = out.split("\n").filter(Boolean);
  const messages = lines.map((line) => JSON.parse(line));
  assert.equal(messages.length, 4);
  assert.ok(messages.every((message) => message.jsonrpc === "2.0"));
  assert.equal(messages.find((message) => message.id === 3).result.isError, true);
  assert.match(messages.find((message) => message.id === 3).result.content[0].text, /not logged in|AUTH|login/iu);
  assert.equal(err, "", "no stderr output without RELO_DEBUG");
});

test("every MCP tool is a registry command, and every argument an option that command takes from an agent", async () => {
  const { TOOL_SPECS, optionOf, toolArgv } = await import("../src/agent/mcp.mjs");
  const { COMMANDS, handlerFor, optionsOf } = await import("../src/registry.mjs");
  for (const spec of TOOL_SPECS) {
    const entry = COMMANDS.find((candidate) => candidate.name === spec.command);
    assert.ok(entry, `${spec.name}: no command ${spec.command}`);
    const handler = handlerFor(entry, "agent");
    assert.ok(handler?.load, `${spec.name}: ${spec.command} does not serve agent sessions`);
    const accepted = new Set(handler.options ?? optionsOf(entry));
    for (const [key, arg] of Object.entries(spec.args)) {
      if (arg.positional) { assert.ok(entry.positionals, `${spec.name}.${key}: ${spec.command} takes no positional`); continue; }
      const options = arg.choice ? Object.values(arg.choice) : [arg.seconds ?? optionOf(key)];
      for (const option of options) assert.ok(accepted.has(option), `${spec.name}.${key}: ${spec.command} does not take --${option}`);
    }
  }
  const start = TOOL_SPECS.find((spec) => spec.name === "relo_work_start");
  assert.deepEqual(toolArgv(start, { goal: "Ship 0.18", plan: ["Build", "Ship"], new: true }),
    ["work", "start", "--json", "--goal=Ship 0.18", "--plan=Build,Ship", "--new"]);
  const ask = TOOL_SPECS.find((spec) => spec.name === "relo_ask");
  assert.deepEqual(toolArgv(ask, { question: "--Deploy?", kind: "yes_no", topic: "Release" }),
    ["ask", "–Deploy?", "--json", "--yes-no", "--timeout=300s", "--topic=Release"]);
});
