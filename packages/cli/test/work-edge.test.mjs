// The CLI is the edge (ADR 0008 principle 13): the declared working copy, its rebuild from the producer's
// own sealed copy (EDGE.4, 2.21), the declared outbox lane (EDGE.3), finish replacing the status (#20),
// owner actions refused as steps (#19) and split-label warnings (#15).
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { ReloApiClient } from "../src/api-client.mjs";
import { b64u, generateKeyPair, keyId, prekeySigningInput, signBytes } from "../src/e2ee.mjs";

const worksContract = new URL("../../contracts/dist/src/works.js", import.meta.url);
const skip = !existsSync(worksContract) && "build @relo/notification-contracts first";

function phone(deviceId) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = "2026-10-13T16:00:00.000Z";
  return { deviceId, name: "iPhone", model: "iPhone", isSimulator: false,
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } };
}

/** A session-works server with the contract's plan rules, idempotency receipts and a switchable network. */
function edgeServer(c) {
  const works = [];
  const calls = [];
  const receipts = new Map();
  const net = { down: false, dropNextResponse: false };
  let n = 0;
  const respond = (o, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => structuredClone(o) });
  const open = () => works.find((w) => w.lifecycle === "open");
  const summary = (w) => ({ ...w, plan: { ...w.plan, complete: c.planComplete(w.plan) } });
  const answer = (w, disposition, status = 200) => ({ status, body: { work: summary(w), disposition, replayed: false, ignored: [], parked: works.filter((x) => x !== w && x.lifecycle === "paused").map(summary) } });
  const text = (value) => (value && "readable" in value ? value.readable : null);
  const refuse = (error, status) => ({ status, body: { error, message: error } });
  function plan(w, command) {
    if (!command) return null;
    const result = c.applyPlanCommand(w.plan, command, w.version + 1, { sealed: w.sealed });
    if (!result.ok) return refuse(result.code, 422);
    w.plan = result.plan;
    return null;
  }
  function apply(method, path, body) {
    if (path === "/api/session/works" && method === "POST") {
      const sealed = "sealed" in body.goal;
      const cur = open();
      if (cur && !body.new) return answer(cur, "continuing");
      if (cur) { cur.lifecycle = "paused"; cur.pausedReason = "parked"; }
      const w = { id: `wrk_${(++n).toString(16).padStart(8, "b")}-0000`, version: 1, lifecycle: "open", pausedReason: null, sealed,
        goal: text(body.goal), status: body.status ? text(body.status) : null, outcome: null, waiting: null, plan: c.EMPTY_WORK_PLAN, progress: null,
        ...(body.producerSealed ? { producerSealed: body.producerSealed } : {}), card: null };
      const refused = plan(w, body.plan);
      if (refused) return refused;
      works.push(w);
      return answer(w, cur ? "switched" : "started", 201);
    }
    const m = path.match(/works\/([^/]+)(?:\/(\w+))?$/u);
    const w = m[1] === "current" ? open() : m[1] === "newest" ? works.find((x) => x.lifecycle === "paused") : works.find((x) => x.id === m[1]);
    if (!w) return m[1] === "current" ? refuse("not_open", 409) : refuse("not_found", 404);
    if (w.lifecycle === "finished" || w.lifecycle === "failed" || w.lifecycle === "dropped") return refuse("work_finished", 409);
    if (method === "PATCH") {
      if (body.baseVersion !== undefined && body.baseVersion !== w.version) return refuse("version_conflict", 409);
      for (const value of [body.goal, body.status, body.waiting?.reason]) if (value && ("sealed" in value) !== w.sealed) return refuse("invalid_request", 422);
      if (body.goal) w.goal = text(body.goal);
      if (body.status) w.status = text(body.status);
      if (body.waiting !== undefined) w.waiting = body.waiting ? { reason: text(body.waiting.reason), since: new Date().toISOString() } : null;
      const refused = plan(w, body.plan);
      if (refused) return refused;
      if (body.progress) {
        const cur = w.plan.steps.find((s) => s.state === "current");
        if (cur) cur.progress = body.progress; else w.progress = body.progress;
      }
      if (body.producerSealed) w.producerSealed = body.producerSealed;
      w.version += 1;
      return answer(w, "updated");
    }
    if (m[2] === "pause") { w.lifecycle = "paused"; w.pausedReason = "declared"; w.status = text(body.status); if (body.producerSealed) w.producerSealed = body.producerSealed; w.version += 1; return answer(w, "paused"); }
    if (m[2] === "resume") { const cur = open(); if (cur && cur !== w) cur.lifecycle = "paused"; w.lifecycle = "open"; w.pausedReason = null; w.version += 1; return answer(w, "resumed"); }
    if (m[2] === "finish") {
      w.lifecycle = body.result; w.outcome = text(body.outcome); w.status = null; w.waiting = null;
      w.plan = c.closePlan(w.plan, body.result); w.version += 1;
      return answer(w, "finished");
    }
    return refuse("invalid_request", 400);
  }
  const fetchImpl = async (url, init) => {
    if (net.down) throw new TypeError("fetch failed");
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const key = init.headers["idempotency-key"];
    calls.push({ method: init.method, path: u.pathname, headers: init.headers, body });
    if (init.method === "GET") {
      const live = works.filter((w) => w.lifecycle === "open" || w.lifecycle === "paused").map(summary);
      return respond({ open: live.find((w) => w.lifecycle === "open") ?? null, parked: live.filter((w) => w.lifecycle === "paused") });
    }
    let out;
    if (key && receipts.has(key)) out = { status: 200, body: { ...receipts.get(key), replayed: true } };
    else {
      out = apply(init.method, u.pathname, body);
      if (key && out.status < 300) receipts.set(key, out.body);
    }
    if (net.dropNextResponse) { net.dropNextResponse = false; throw new TypeError("socket hang up"); }
    return respond(out.body, out.status);
  };
  return { fetchImpl, calls, works, net, writes: () => calls.filter((call) => call.method !== "GET") };
}

async function session(sessionId, { sealed = false } = {}) {
  const c = await import(worksContract.href);
  const state = mkdtempSync(join(tmpdir(), "relo-edge-"));
  const server = edgeServer(c);
  const device = sealed ? phone("dev_00000000-0000-4000-8000-00000000000a") : undefined;
  const env = { XDG_STATE_HOME: state, CLAUDE_CODE_SESSION_ID: sessionId, RELO_KEY_STORE_PATH: join(state, "e2ee.json"), RELO_SEALED_CARD_DIR: join(state, "cards", "sealed") };
  const overrides = {
    env,
    loadConfig: async () => ({ apiUrl: "http://relo.test", token: "t".repeat(44) }),
    configPath: () => join(state, "config.json"),
    clientFactory: (config) => {
      const client = new ReloApiClient({ apiUrl: config.apiUrl, token: config.token, fetchImpl: server.fetchImpl });
      if (device) {
        // The key directory follows the same network as the works routes.
        client.listDeviceKeys = async () => { if (server.net.down) throw Object.assign(new Error("fetch failed"), { code: "NETWORK_ERROR" }); return { devices: [device] }; };
        client.publishClientKey = async () => ({});
        client.listDevices = async () => ({ devices: [] });
      }
      return client;
    },
  };
  const relo = async (...argv) => {
    const out = [];
    const code = await run(argv, { stdout: (l) => out.push(l), stderr: (l) => out.push(l), stdoutIsTTY: false }, overrides);
    return { code, text: out.join("\n") };
  };
  const sessionFile = join(state, "relo", "sessions");
  return { relo, server, state, sessionFile, done: () => rmSync(state, { recursive: true, force: true }) };
}

const clearSessionFiles = (s) => rmSync(s.sessionFile, { recursive: true, force: true });

test("offline write is queued, succeeds locally and is sent first by the next command", { skip }, async (t) => {
  const s = await session("edge-offline");
  t.after(s.done);
  assert.equal((await s.relo("work", "start", "--goal", "Fix the login crash", "--plan", "Reproduce the crash,Find the cause")).code, 0);
  s.server.net.down = true;
  let r = await s.relo("work", "update", "--next-step", "--status", "Reading the stack trace");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^Queued: sends with the next relo command$/mu);
  assert.match(r.text, /\[>\] s2 Find the cause/u);
  assert.match(r.text, /Owner sees: the last change Relo received/u);
  assert.equal(s.server.works[0].plan.steps[0].state, "current", "nothing reached the server");
  r = await s.relo("state");
  assert.match(r.text, /^Queued: 1 change not sent yet/mu);
  s.server.net.down = false;
  r = await s.relo("work", "update", "--status", "Writing the regression test");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Note: sent 1 queued change/u);
  assert.doesNotMatch(r.text, /^Queued:/mu);
  const patches = s.server.writes().filter((call) => call.method === "PATCH");
  assert.deepEqual(patches.map((call) => [call.body.plan?.op ?? null, call.body.status?.readable ?? null]),
    [["next", "Reading the stack trace"], [null, "Writing the regression test"]]);
  assert.equal(patches[0].body.baseVersion, 1, "a write tried before the network failed replays as it was");
  assert.deepEqual(s.server.works[0].plan.steps.map((step) => step.state), ["done", "current"]);
  assert.equal(s.server.works[0].status, "Writing the regression test");
  assert.doesNotMatch((await s.relo("state")).text, /Queued/u);
});

test("queued writes keep their order, and a new write waits behind them", { skip }, async (t) => {
  const s = await session("edge-order");
  t.after(s.done);
  await s.relo("work", "start", "--goal", "Release 0.18", "--plan", "Build the server,Run the gates,Deploy");
  s.server.net.down = true;
  for (const argv of [["--status", "Compiling"], ["--next-step"], ["--status", "Gates running"], ["--add", "Tag the release"], ["--next-step", "--status", "Deploying"]]) {
    assert.equal((await s.relo("work", "update", ...argv)).code, 0, argv.join(" "));
  }
  s.server.net.down = false;
  const r = await s.relo("state");
  assert.match(r.text, /sent 5 queued changes/u);
  const sent = s.server.writes().filter((call) => call.method === "PATCH").map((call) => [call.body.plan?.op ?? "-", call.body.status?.readable ?? "-"]);
  assert.deepEqual(sent, [["-", "Compiling"], ["next", "-"], ["-", "Gates running"], ["add", "-"], ["next", "Deploying"]]);
  const bases = s.server.writes().filter((call) => call.method === "PATCH").map((call) => call.body.baseVersion);
  assert.deepEqual(bases.slice(1), [undefined, undefined, undefined, undefined], "writes queued behind others drop baseVersion");
  assert.deepEqual(s.server.works[0].plan.steps.map((step) => `${step.id}:${step.state}`), ["s1:done", "s2:done", "s3:current", "s4:open"]);
  assert.match(r.text, /\[>\] s3 Deploy/u);
});

test("an offline start queues; later writes name the session's open work until the server has it", { skip }, async (t) => {
  const s = await session("edge-offline-start");
  t.after(s.done);
  s.server.net.down = true;
  let r = await s.relo("work", "start", "--goal", "Migrate the database", "--plan", "Write the migration,Run it on staging");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^Work wrk_queued "Migrate the database" \(open, started\)/mu);
  assert.match(r.text, /^Queued: sends with the next relo command$/mu);
  r = await s.relo("work", "update", "--next-step");
  assert.equal(r.code, 0, r.text);
  s.server.net.down = false;
  r = await s.relo("state");
  assert.match(r.text, /^Work wrk_bbbbbbb1 "Migrate the database" \(open\)/mu, r.text);
  const writes = s.server.writes().filter((call) => call.path.startsWith("/api/session/"));
  assert.deepEqual(writes.map((call) => `${call.method} ${call.path}`), ["POST /api/session/works", "PATCH /api/session/works/current"]);
  assert.deepEqual(s.server.works[0].plan.steps.map((step) => step.state), ["done", "current"]);
  assert.match(r.text, /\[>\] s2 Run it on staging/u);
});

test("a write that reached the server before the network failed replays its first result", { skip }, async (t) => {
  const s = await session("edge-replay");
  t.after(s.done);
  await s.relo("work", "start", "--goal", "Ship the docs", "--plan", "Draft the guide,Review the guide,Publish");
  s.server.net.dropNextResponse = true;
  let r = await s.relo("work", "update", "--next-step");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^Queued:/mu);
  r = await s.relo("work", "update", "--status", "Reviewing");
  assert.equal(r.code, 0, r.text);
  const patches = s.server.writes().filter((call) => call.method === "PATCH");
  assert.equal(patches.length, 3, "first try, replay, new write");
  assert.equal(patches[1].headers["idempotency-key"], patches[0].headers["idempotency-key"], "the replay uses the first key");
  assert.deepEqual(patches[1].body, patches[0].body, "and the same body");
  assert.deepEqual(s.server.works[0].plan.steps.map((step) => step.state), ["done", "current", "open"], "applied once");
});

test("a lost state file is rebuilt from the producer's own sealed copy; --plan still matches labels", { skip }, async (t) => {
  const s = await session("edge-rebuild", { sealed: true });
  t.after(s.done);
  let r = await s.relo("work", "start", "--goal", "Fix the login crash", "--plan", "Reproduce the crash,Find the cause", "--status", "Reading logs");
  assert.equal(r.code, 0, r.text);
  const start = s.server.writes()[0];
  assert.deepEqual(start.body.goal, { sealed: true });
  assert.ok(start.body.producerSealed?.ciphertext, "the start carries this computer's own copy");
  assert.ok(!JSON.stringify(start.body).includes("Reproduce the crash"), "no readable label reaches the server");
  assert.equal(s.server.works[0].goal, null);
  clearSessionFiles(s);
  r = await s.relo("state");
  assert.match(r.text, /^Work wrk_bbbbbbb1 "Fix the login crash" \(open\)/mu, r.text);
  assert.match(r.text, /\[>\] s1 Reproduce the crash/u);
  clearSessionFiles(s);
  r = await s.relo("work", "update", "--plan", "Find the cause,Write a regression test");
  assert.equal(r.code, 0, r.text);
  const patch = s.server.writes().at(-1);
  assert.deepEqual(patch.body.plan, { op: "set", steps: [{ id: "s2" }, { id: "s3" }] }, "Find the cause matched s2 by its rebuilt label");
  assert.match(r.text, /\[>\] s2 Find the cause/u);
  assert.match(r.text, /\[ \] s3 Write a regression test/u);
  assert.ok(patch.body.producerSealed?.ciphertext, "every write refreshes the copy");
  clearSessionFiles(s);
  r = await s.relo("work", "update", "--step", "Write a regression test");
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(s.server.writes().at(-1).body.plan, { op: "step", id: "s3" });
});

test("finish replaces the status with the outcome and marks the current step done", { skip }, async (t) => {
  const s = await session("edge-finish");
  t.after(s.done);
  await s.relo("work", "start", "--goal", "Redeploy the server", "--plan", "Build the image,Redeploy", "--status", "Building the image");
  await s.relo("work", "update", "--next-step", "--status", "Redeploying server 0.17.1");
  let r = await s.relo("work", "finish", "--outcome", "Server 0.17.1 is live");
  assert.equal(r.code, 0, r.text);
  assert.doesNotMatch(r.text, /Status: Redeploying/u);
  assert.match(r.text, /Outcome: Server 0.17.1 is live/u);
  assert.match(r.text, /\[x\] s2 Redeploy/u);
  assert.equal(s.server.works[0].status, null);
  await s.relo("work", "start", "--goal", "Rotate the keys", "--plan", "Rotate,Verify", "--status", "Rotating");
  r = await s.relo("work", "finish", "--failed", "--outcome", "Rotation failed on staging");
  assert.match(r.text, /\[-\] 2 skipped: s1 Rotate, s2 Verify/u);
  r = await s.relo("work", "finish", "--outcome", "Nothing open", "--dry-run");
  assert.notEqual(r.code, 0);
});

test("plan steps that name the owner's actions are refused in three lines", { skip }, async (t) => {
  const s = await session("edge-owner");
  t.after(s.done);
  for (const plan of ["Build the release,Owner installs iPhone", "Build,Verify on the phone", "Ship it,You approve the release", "Wait for approval,Deploy", "Install on my phone,Ship"]) {
    const r = await s.relo("work", "start", "--goal", "Release 0.18", "--plan", plan);
    assert.equal(r.code, 2, plan);
    const lines = r.text.split("\n");
    assert.equal(lines.length, 3, r.text);
    assert.match(lines[0], /^Refused: step ".+" is something the owner does; .*an ask .*or a note, never a step/u);
    assert.match(lines[1], /^State: /u);
    assert.match(lines[2], /^Next: /u);
  }
  assert.equal(s.server.writes().length, 0);
  const ok = await s.relo("work", "start", "--goal", "Release 0.18", "--plan", "Build the release,Update user settings page,Install on the device");
  assert.equal(ok.code, 0, ok.text);
});

test("--plan splits only on top-level commas and warns when a label looks split", { skip }, async (t) => {
  const s = await session("edge-split");
  t.after(s.done);
  let r = await s.relo("work", "start", "--goal", "Release 0.10", "--plan", "Build the app,Install 0.10.0 (later, on staging),Ship");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\[ \] s2 Install 0.10.0 \(later, on staging\)/u);
  assert.doesNotMatch(r.text, /looks like the end/u);
  r = await s.relo("work", "update", "--add", "Write the notes for,the release");
  assert.match(r.text, /Note: step "the release" looks like the end of "Write the notes for" split at a comma/u);
});

test("on an end-to-end account a queued write is sealed when it is sent, never sent readable", { skip }, async (t) => {
  const s = await session("edge-sealed-queue", { sealed: true });
  t.after(s.done);
  assert.equal((await s.relo("work", "start", "--goal", "Rotate the signing keys", "--plan", "Rotate,Verify")).code, 0);
  s.server.net.down = true;
  let r = await s.relo("work", "update", "--next-step", "--status", "Checking the new keys");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^Queued: sends with the next relo command$/mu);
  s.server.net.down = false;
  r = await s.relo("work", "update", "--waiting", "CI");
  assert.equal(r.code, 0, r.text);
  const patches = s.server.writes().filter((call) => call.method === "PATCH");
  assert.equal(patches.length, 2);
  for (const call of patches) {
    assert.ok(!JSON.stringify(call.body).includes("Checking the new keys") && !JSON.stringify(call.body).includes("\"CI\""), JSON.stringify(call.body));
    assert.ok(call.body.sealed && call.body.producerSealed, "card and self copy sealed at send time");
  }
  assert.deepEqual(patches[0].body.status, { sealed: true });
  assert.deepEqual(s.server.works[0].plan.steps.map((step) => step.state), ["done", "current"]);
  clearSessionFiles(s);
  r = await s.relo("state");
  assert.match(r.text, /Waiting on: CI/u, r.text);
  assert.match(r.text, /\[>\] s2 Verify/u);
});

test("the background flusher (relo outbox flush) sends queued declared writes on the session's key", { skip }, async (t) => {
  const s = await session("edge-background");
  t.after(s.done);
  await s.relo("work", "start", "--goal", "Tidy the release notes", "--plan", "Collect changes,Write notes");
  const sessionKey = s.server.calls[0].headers["relo-session-key"];
  s.server.net.down = true;
  const queued = await s.relo("work", "update", "--next-step", "--status", "Writing");
  assert.match(queued.text, /^Queued: sends with the next relo command$/mu);
  s.server.net.down = false;
  const r = await s.relo("outbox", "flush");
  assert.equal(r.code, 0, r.text);
  const patch = s.server.writes().at(-1);
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.headers["relo-session-key"], sessionKey);
  assert.deepEqual(patch.body.status, { readable: "Writing" });
  assert.deepEqual(s.server.works[0].plan.steps.map((step) => step.state), ["done", "current"]);
});
