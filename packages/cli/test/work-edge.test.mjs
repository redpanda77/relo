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
import { ReloApiClient } from "../src/shared/api-client.mjs";
import { b64u, fromB64u, generateKeyPair, keyId, openEnvelope, prekeySigningInput, signBytes } from "../src/crypto/e2ee.mjs";
import { keyStorePath, loadKeyStore } from "../src/crypto/keystore.mjs";

const worksContract = new URL("../../contracts/dist/src/works.js", import.meta.url);
const skip = !existsSync(worksContract) && "build @relo/notification-contracts first";

function phone(deviceId, keys = {}) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  keys.prekey = prekey;
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
  const net = { down: false, dropNextResponse: false, refuse: undefined };
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
      if (cur && !body.new) {
        if (c.lastRound(cur.plan).state === "closed") {
          // The last round is delivered: a start with a round opens the next one, else the server names the flag.
          if (!body.round) return refuse("round_required", 409);
          const opened = c.applyPlanCommand(cur.plan, { op: "round", ...(text(body.round) ? { title: text(body.round) } : {}), ...(body.plan ? { steps: body.plan.steps } : {}) }, cur.version + 1, { sealed: cur.sealed });
          if (!opened.ok) return refuse(opened.code, 422);
          cur.plan = opened.plan; cur.status = null; cur.version += 1;
          if (body.producerSealed) cur.producerSealed = body.producerSealed;
          return answer(cur, "round_opened");
        }
        return answer(cur, "continuing");
      }
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
    if (net.refuse && method !== "GET") { const code = net.refuse; net.refuse = undefined; return refuse(code, 422); }
    if (method === "PATCH") {
      if (body.plan && c.lastRound(w.plan).state === "closed") return refuse("round_closed", 409);
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
    if (m[2] === "deliver") {
      if (c.lastRound(w.plan).state === "closed") return refuse("round_closed", 409);
      const closed = c.applyPlanCommand(w.plan, { op: "close", ...(text(body.outcome) ? { outcome: text(body.outcome) } : {}), ...(body.dropRest ? { dropRest: true } : {}) }, w.version + 1, { sealed: w.sealed });
      if (!closed.ok) return refuse(closed.code, 422);
      w.plan = closed.plan; w.status = null; w.waiting = null; w.version += 1;
      if (body.producerSealed) w.producerSealed = body.producerSealed;
      return answer(w, "delivered");
    }
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

async function session(sessionId, { sealed = false, env: extra = {} } = {}) {
  const c = await import(worksContract.href);
  const state = mkdtempSync(join(tmpdir(), "relo-edge-"));
  const server = edgeServer(c);
  const keys = {};
  const device = sealed ? phone("dev_00000000-0000-4000-8000-00000000000a", keys) : undefined;
  const env = { XDG_STATE_HOME: state, CLAUDE_CODE_SESSION_ID: sessionId, RELO_KEY_STORE_PATH: join(state, "e2ee.json"), ...extra };
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
  /** Opens a sealed write's card content envelope as the phone (and a linked browser) would. */
  const openCard = async (body) => {
    const store = await loadKeyStore(keyStorePath(overrides.configPath(), env));
    return openEnvelope(body.sealed.content, { deviceId: device.deviceId, prekeyPrivateKey: () => keys.prekey.privateKey,
      trustedSenders: { [store.identity.keyId]: fromB64u(store.identity.publicKey) }, expectedKind: "card" }).content;
  };
  /** Opens a write's own sealed outcome notification (kind "notice") as the phone would. */
  const openOutcome = async (body) => {
    const store = await loadKeyStore(keyStorePath(overrides.configPath(), env));
    return openEnvelope(body.sealedOutcome.content, { deviceId: device.deviceId, prekeyPrivateKey: () => keys.prekey.privateKey,
      trustedSenders: { [store.identity.keyId]: fromB64u(store.identity.publicKey) }, expectedKind: "notice" }).content;
  };
  return { relo, server, state, sessionFile, openCard, openOutcome, done: () => rmSync(state, { recursive: true, force: true }) };
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
  const ok = await s.relo("work", "start", "--goal", "Release 0.18", "--plan", "Build the release,Update user settings page,Install on the device,Fix the false waiting on you");
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

test("every card envelope of a work carries the start's names, so a reader of any one names the handles", { skip }, async (t) => {
  const s = await session("edge-names", { sealed: true, env: { RELO_PROJECT: "Billing service", RELO_TOPIC: "Login crash" } });
  t.after(s.done);
  assert.equal((await s.relo("work", "start", "--goal", "Fix the login crash", "--plan", "Reproduce,Fix")).code, 0);
  const start = s.server.writes()[0];
  assert.match(start.body.context.project, /^p-[a-z2-7]{16}$/u);
  assert.ok(!JSON.stringify(start.body.context).includes("Billing service"), "the server sees handles only");
  const names = (await s.openCard(start.body)).names;
  assert.equal(names[start.body.context.project], "Billing service");
  assert.equal(names[start.body.context.threadName], "Login crash");
  assert.equal((await s.relo("work", "update", "--next-step", "--status", "Writing the fix")).code, 0);
  assert.equal((await s.relo("work", "pause", "--status", "Waiting for the logs")).code, 0);
  assert.equal((await s.relo("work", "resume")).code, 0);
  // A queued write is sealed when it is sent, and still names the handles.
  s.server.net.down = true;
  assert.equal((await s.relo("work", "update", "--status", "Testing the fix")).code, 0);
  s.server.net.down = false;
  assert.equal((await s.relo("work", "finish", "--outcome", "Login works again")).code, 0);
  const cards = s.server.writes().filter((call) => call.body?.sealed);
  assert.deepEqual(cards.map((call) => call.path.split("/").at(-1)), ["works", s.server.works[0].id, "pause", s.server.works[0].id, "finish"]);
  for (const call of cards) {
    const opened = await s.openCard(call.body);
    assert.deepEqual(opened.names, names, `${call.method} ${call.path} carries the start's names`);
  }
  assert.equal((await s.openCard(cards.at(-1).body)).status, "Login works again");
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

// ---- the working layer skeleton (ADR 0012): deliver, rounds, nested plans, refusal memory ----

const cardOf = async (s, body) => { const { names: _names, ...text } = await s.openCard(body); return text; };
const workWrites = (s) => s.server.writes().filter((call) => call.path.startsWith("/api/session/works"));
const sessionJson = async (s) => {
  const { readdir, readFile } = await import("node:fs/promises");
  const [name] = await readdir(s.sessionFile);
  return JSON.parse(await readFile(join(s.sessionFile, name), "utf8"));
};

test("deliver keeps the work open; a start without --round is refused; start --round opens round 2", { skip }, async (t) => {
  const s = await session("rounds-basic");
  t.after(s.done);
  assert.equal((await s.relo("work", "start", "--goal", "Fix the login crash", "--plan", "Reproduce the crash,Find the cause")).code, 0);
  let r = await s.relo("work", "update", "--next-step");
  r = await s.relo("work", "deliver", "--outcome", "Crash reproduced and fixed");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^Work wrk_\w{8} "Fix the login crash" \(open, delivered\)/u);
  assert.match(r.text, /^ {2}\[✓\] Round 1 "Fix the login crash": Crash reproduced and fixed$/mu);
  assert.match(r.text, /^Owner sees: the round's final card and one quiet notification: "Crash reproduced and fixed"; then it's the owner's turn$/mu);
  assert.match(r.text, /^Next: .*relo work start --round .*relo work finish/mu);
  assert.equal(s.server.works[0].lifecycle, "open", "deliver does not finish the work");
  assert.deepEqual(s.server.works[0].plan.rounds.map((round) => [round.n, round.state, round.outcome]), [[1, "closed", "Crash reproduced and fixed"]]);
  assert.equal((await sessionJson(s)).open.id, s.server.works[0].id, "the session file keeps the work");

  const writes = workWrites(s).length;
  r = await s.relo("work", "start", "--goal", "Fix the login crash");
  assert.equal(r.code, 2);
  assert.equal(r.text.split("\n").length, 3, r.text);
  assert.match(r.text, /^Refused: round 1 "Fix the login crash" of wrk_\w{8} is delivered \("Crash reproduced and fixed"\), so a follow-up on this goal opens a new round\.$/mu);
  assert.match(r.text, /^Next: relo work start --round /mu);
  assert.equal(workWrites(s).length, writes, "refused before any request");

  r = await s.relo("work", "update", "--next-step");
  assert.equal(r.code, 2, "a delivered round has no steps to move");
  assert.match(r.text, /^Refused: round 1 is delivered, so there are no steps to move through\./u);

  r = await s.relo("work", "start", "--round", "Add the dark theme", "--plan", "Design the tokens,Wire the toggle");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\(open, round_opened\)/u);
  assert.match(r.text, /^ {2}\[✓\] Round 1 "Fix the login crash": Crash reproduced and fixed$/mu);
  assert.match(r.text, /^ {2}Round 2 "Add the dark theme"$/mu);
  assert.match(r.text, /^ {4}\[>\] s3 Design the tokens$/mu);
  assert.match(r.text, /Owner sees: on the Lock Screen, "Step 1 of 2 · Design the tokens"/u);
  assert.equal(s.server.works.length, 1, "one work for the whole goal");
  assert.deepEqual(s.server.works[0].plan.steps.map((step) => `${step.id}:${step.round}:${step.state}`), ["s1:1:done", "s2:1:done", "s3:2:current", "s4:2:open"]);

  // An open round continues as today and says --round was ignored.
  r = await s.relo("work", "start", "--round", "Another one");
  assert.match(r.text, /\(open, continuing\)/u);
  assert.match(r.text, /Note: --round was ignored: round 2 is still open; deliver it first/u);
  // finish ends the goal
  r = await s.relo("work", "deliver", "--outcome", "Dark theme shipped");
  r = await s.relo("work", "finish", "--outcome", "Login fixed and the dark theme shipped");
  assert.match(r.text, /\(finished, done\)/u);
  assert.equal(s.server.works[0].lifecycle, "finished");
});

test("a finished goal takes a follow-up: start --round starts a fresh card for the same goal", { skip }, async (t) => {
  const s = await session("rounds-after-finish");
  t.after(s.done);
  assert.equal((await s.relo("work", "start", "--goal", "Fix the login crash", "--plan", "Reproduce the crash,Fix it")).code, 0);
  await s.relo("work", "update", "--next-step");
  let r = await s.relo("work", "update", "--next-step");
  assert.match(r.text, /^Next: done: relo work finish /mu, "a complete plan points at finish first");
  r = await s.relo("work", "finish", "--outcome", "Login crash fixed");
  assert.equal(r.code, 0, r.text);
  assert.equal((await sessionJson(s)).finishedGoal, "Fix the login crash");

  r = await s.relo("work", "start", "--round", "Also the logout crash", "--plan", "Reproduce it");
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^Work wrk_\w{8} "Fix the login crash" \(open, started\)/u);
  assert.match(r.text, /Note: "Fix the login crash" was finished, so this follow-up starts a new card for it/u);
  assert.equal(s.server.works.length, 2, "finished work is not reopened");
  assert.equal(s.server.works[1].lifecycle, "open");
});

test("a nested plan is parsed by indentation, kept leaf to leaf, extended with --under and given a detail", { skip }, async (t) => {
  const s = await session("rounds-tree");
  t.after(s.done);
  let r = await s.relo("work", "start", "--goal", "Ship the importer", "--plan", "Read the spec\nBuild it\n  Parse the rows\n  Write the rows\nVerify it");
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(workWrites(s)[0].body.plan.steps, [{ label: "Read the spec" }, { label: "Build it", children: [{ label: "Parse the rows" }, { label: "Write the rows" }] }, { label: "Verify it" }]);
  assert.match(r.text, /^ {2}\[>\] s1 Read the spec$/mu);
  assert.match(r.text, /^ {2}\[ \] s2 Build it$/mu);
  assert.match(r.text, /^ {4}\[ \] s3 Parse the rows$/mu);
  r = await s.relo("work", "update", "--next-step");
  assert.match(r.text, /^ {2}\[>\] s2 Build it$/mu, "a parent on the path to the current step shows [>]");
  assert.match(r.text, /^ {4}\[>\] s3 Parse the rows$/mu);
  assert.match(r.text, /Owner sees: on the Lock Screen, "Step 2 of 3 · Build it · 0\/2"/u);
  r = await s.relo("work", "update", "--add", "Handle the quotes", "--under", "s3", "--detail", "Quotes inside quoted fields break the split");
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(workWrites(s).filter((call) => call.method === "PATCH").slice(-2).map((call) => call.body.plan), [{ op: "add", steps: [{ label: "Handle the quotes" }], under: "s3" }, { op: "detail", detail: "Quotes inside quoted fields break the split" }]);
  assert.match(r.text, /^ {6}\[>\] s6 Handle the quotes$/mu, "the new child of the current step takes over");
  assert.match(r.text, /^ {8}Quotes inside quoted fields break the split$/mu);
  const local = await sessionJson(s);
  assert.deepEqual(local.open.plan.steps.map((step) => [step.id, step.parent, step.state]), s.server.works[0].plan.steps.map((step) => [step.id, step.parent, step.state]), "the local copy mirrors the server's plan");
  r = await s.relo("work", "update", "--next-step");
  assert.deepEqual(s.server.works[0].plan.steps.filter((step) => step.state === "current").map((step) => step.id), ["s4"], "next moves from leaf to leaf");
  r = await s.relo("work", "update", "--add", "Tidy the imports", "--under", "s99");
  assert.equal(r.code, 2);
  assert.match(r.text, /^Refused: no step "s99" in this round to add under\./u);
  r = await s.relo("work", "update", "--under", "s2");
  assert.match(r.text, /^Refused: --under says where --add puts new steps, and there is no --add\./u);
  const deep = await s.relo("work", "update", "--add", "Level one\n  Level two\n    Level three\n      Level four");
  assert.equal(deep.code, 2);
  assert.equal(deep.text.split("\n").length, 3, deep.text);
  assert.match(deep.text, /^Refused: step "Level four" would sit deeper than 3 levels/u);
});

test("a refused finish or deliver is remembered, shown first on every echo and cleared by an accepted one", { skip }, async (t) => {
  const s = await session("rounds-refusal");
  t.after(s.done);
  assert.equal((await s.relo("work", "start", "--goal", "Rotate the keys", "--plan", "Rotate,Verify")).code, 0);
  const long = `${"Rotated every signing key and verified the new ones on staging and production, then rolled back the old ones, ".repeat(3)}done`;
  let r = await s.relo("work", "deliver", "--outcome", long);
  assert.equal(r.code, 2);
  const [what, state, next] = r.text.split("\n");
  assert.match(what, /^Refused: --outcome is \d+ characters; the limit is 200\./u);
  const cut = /^Next: relo work deliver --outcome "(.*)"$/u.exec(next)?.[1];
  assert.ok(cut && Array.from(cut).length <= 200 && cut.endsWith("…") && long.startsWith(cut.slice(0, 40)), next);
  const kept = (await sessionJson(s)).pendingRefusal;
  assert.deepEqual([kept.verb, kept.code], ["deliver", "CONTENT_REFUSED"]);
  assert.match(kept.what, /^--outcome is \d+ characters/u);
  for (const argv of [["state"], ["work", "update", "--status", "Verifying the new keys"]]) {
    r = await s.relo(...argv);
    assert.match(r.text.split("\n")[0], /^Refused earlier: --outcome is \d+ characters; the limit is 200\.[^\n]* \(relo work deliver, \d\d:\d\d\)\. The card is still open\. Next: relo work deliver --outcome ".*…"$/u, r.text);
  }
  // a server refusal is remembered the same way
  r = await s.relo("work", "deliver", "--outcome", cut, "--drop-rest");
  assert.equal(r.code, 0, r.text);
  assert.doesNotMatch(r.text, /Refused earlier/u, "an accepted deliver clears it");
  assert.equal((await sessionJson(s)).pendingRefusal, undefined);
  s.server.net.refuse = "text_refused";
  r = await s.relo("work", "finish", "--outcome", "Keys rotated");
  assert.equal(r.code, 2);
  assert.equal((await sessionJson(s)).pendingRefusal.verb, "finish");
  r = await s.relo("state");
  assert.match(r.text.split("\n")[0], /^Refused earlier: .* \(relo work finish, \d\d:\d\d\)\. The card is still open\. Next: /u);
  r = await s.relo("work", "finish", "--outcome", "Keys rotated");
  assert.equal(r.code, 0, r.text);
  assert.equal((await sessionJson(s)).pendingRefusal, undefined);
});

test("on an end-to-end account rounds, outcomes and details travel only in the sealed card text (v2 phases)", { skip }, async (t) => {
  const s = await session("rounds-sealed", { sealed: true });
  t.after(s.done);
  let r = await s.relo("work", "start", "--goal", "Rotate the signing keys", "--plan", "Rotate\nVerify\n  Check staging\n  Check production");
  assert.equal(r.code, 0, r.text);
  const start = workWrites(s)[0].body;
  assert.deepEqual(start.plan, { op: "set", steps: [{ id: "s1" }, { id: "s2", children: [{ id: "s3" }, { id: "s4" }] }] }, "predicted ids in pre-order, nested");
  assert.deepEqual(await cardOf(s, start), { title: "Rotate the signing keys", stepId: "s1", phases: [{ id: "r1", steps: [{ id: "s1", label: "Rotate" }, { id: "s2", label: "Verify" }, { id: "s3", label: "Check staging" }, { id: "s4", label: "Check production" }] }] });
  r = await s.relo("work", "update", "--detail", "Rotating the staging key first");
  assert.equal(r.code, 0, r.text);
  const patch = workWrites(s).at(-1).body;
  assert.equal(patch.plan, undefined, "a sealed work sends no readable detail");
  assert.equal((await cardOf(s, patch)).phases[0].steps[0].detail, "Rotating the staging key first");
  r = await s.relo("work", "deliver", "--outcome", "Staging key rotated", "--drop-rest");
  assert.equal(r.code, 0, r.text);
  const delivered = workWrites(s).at(-1).body;
  assert.deepEqual(delivered.outcome, { sealed: true });
  const card = await cardOf(s, delivered);
  assert.equal(card.status, "Staging key rotated");
  assert.equal(card.phases[0].outcome, "Staging key rotated");
  assert.notDeepEqual(delivered.sealedOutcome, delivered.sealed, "the notification is sealed on its own, never the card's envelopes");
  const notice = await s.openOutcome(delivered);
  assert.equal(notice.title, "Rotate the signing keys");
  assert.equal(notice.summary, "Staging key rotated");
  assert.match(r.text, /^ {2}\[✓\] Round 1 "Rotate the signing keys": Staging key rotated$/mu, "the local copy still names the round");
  r = await s.relo("work", "start", "--round", "Rotate the production keys", "--plan", "Rotate production\nVerify production");
  assert.equal(r.code, 0, r.text);
  const round = workWrites(s).at(-1).body;
  assert.deepEqual([round.round, round.plan.steps], [{ sealed: true }, [{ id: "s5" }, { id: "s6" }]], "title sealed; ids continue from the work's next id");
  const two = await cardOf(s, round);
  assert.deepEqual(two.phases.map((phase) => [phase.id, phase.title, phase.outcome]), [["r1", undefined, "Staging key rotated"], ["r2", "Rotate the production keys", undefined]]);
  assert.deepEqual(two.phases[1].steps, [{ id: "s5", label: "Rotate production" }, { id: "s6", label: "Verify production" }]);
  assert.match(r.text, /^ {2}Round 2 "Rotate the production keys"$/mu);
  clearSessionFiles(s);
  r = await s.relo("state");
  assert.match(r.text, /Round 2 "Rotate the production keys"/u, "titles and outcomes come back from the producer's own copy");
  assert.match(r.text, /\[✓\] Round 1 "Rotate the signing keys": Staging key rotated/u);
});

test("a deliver refused for open steps is not remembered: no 'Refused earlier', and the turn-end reminder (R4) still fires", { skip }, async (t) => {
  const s = await session("open-steps-not-pending");
  t.after(s.done);
  assert.equal((await s.relo("work", "start", "--goal", "Build four batches", "--plan", "Batch 1,Batch 2,Batch 3,Batch 4")).code, 0);
  let r = await s.relo("work", "deliver", "--outcome", "Batch 1 built");
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /--drop-rest/u);
  const file = await sessionJson(s);
  assert.equal(file.pendingRefusal, undefined, "an open-steps refusal is never stored");
  r = await s.relo("state");
  assert.doesNotMatch(r.text, /Refused earlier/u);
  const { remind, REMINDER_TURN_SECONDS } = await import("../src/harness/core/remind.mjs");
  const now = Date.parse(file.writtenAt) + 10_000;
  const out = remind({ event: {}, now, state: file, bookkeeping: { turnStartedAt: now - (REMINDER_TURN_SECONDS + 10) * 1000 } });
  assert.equal(out?.reminded.kind, "R4", out?.context);
});
