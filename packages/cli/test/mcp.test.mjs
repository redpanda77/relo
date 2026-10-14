import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { cardKey } from "../src/identity.mjs";
import { SUPPORTED_PROTOCOLS, TOOLS, serveMcp, sourceFromClient, validateArguments } from "../src/mcp.mjs";
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
      const steps = (body.plan?.steps ?? []).map((step, i) => ({ id: `s${i + 1}`, label: step.label, state: i === 0 ? "current" : "open", addedIn: 1 }));
      const work = { id: `wrk_${String(fake.works.length + 1).padStart(8, "0")}`, sessionKey, lifecycle: "open", version: 1, goal: body.goal.readable,
        status: body.status?.readable ?? null, plan: { version: 1, next: steps.length + 1, complete: false, steps }, progress: body.progress ?? null };
      fake.works.push(work);
      return { work: view(work), disposition: "started", parked: [], replayed: false, ignored: [] };
    }
    const work = mine.find((w) => path.includes(w.id));
    if (!work) throw Object.assign(new Error("Work not found in this session."), { status: 404 });
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

test("tools/list names the eight tools, carries the rules and marks the annotations", async () => {
  const mcp = connect();
  await mcp.initialize();
  const { tools } = (await mcp.request("tools/list")).result;
  assert.deepEqual(tools.map((tool) => tool.name), ["relo_work_start", "relo_work_update", "relo_work_finish", "relo_work_state", "relo_ask", "relo_interaction_wait", "relo_notify", "relo_doctor"]);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.relo_doctor.annotations.readOnlyHint, true);
  for (const name of ["relo_work_finish", "relo_notify"]) assert.equal(byName[name].annotations.destructiveHint, false);
  assert.equal(byName.relo_work_state.annotations.readOnlyHint, true);
  assert.match(byName.relo_ask.description, /Only an `approval` question that returns state `approved` is permission/u);
  assert.match(byName.relo_notify.description, /rarely/u);
  assert.match(byName.relo_work_start.description, /secrets/u);
  assert.deepEqual(byName.relo_ask.inputSchema.properties.kind.enum, ["approval", "yes_no"]);
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
