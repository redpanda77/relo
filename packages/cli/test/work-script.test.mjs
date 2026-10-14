import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { EXIT } from "../src/errors.mjs";
import { exitCodeFor, waitForAnswer, waitPlan } from "../src/script/ask.mjs";
import { parseDuration, producerPathKey, resolveProducer } from "../src/script/producer.mjs";
import { leaseSeconds, runScriptWork, scriptRequest } from "../src/script/work.mjs";

const script = { type: "script" };

test("work start without producer key refused", () => {
  assert.throws(() => resolveProducer({}, script), (error) => error.code === "PRODUCER_REQUIRED");
  assert.throws(() => resolveProducer({ name: "x" }, script), (error) => error.code === "NAME_REFUSED");
});

test("--producer and RELO_SESSION give the same scope path", () => {
  const flag = resolveProducer({ producer: "deploy-bot" }, script);
  const env = resolveProducer({}, { type: "script", session: "deploy-bot", producerKey: "deploy-bot" });
  assert.equal(flag, env);
  assert.match(producerPathKey(flag), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(scriptRequest("heartbeat", {}, { producer: flag, workId: "wrk_1" }).path, `/api/producers/${producerPathKey(env)}/works/wrk_1/heartbeat`);
});

test("idempotency key required when piped, generated at a TTY", () => {
  assert.throws(() => scriptRequest("start", { goal: "Deploy" }, { producer: "ci", stdinIsTTY: false }), (error) => error.code === "IDEMPOTENCY_REQUIRED");
  const atTty = scriptRequest("start", { goal: "Deploy" }, { producer: "ci", stdinIsTTY: true });
  assert.ok(atTty.idempotencyKey);
  const named = scriptRequest("start", { goal: "Deploy", "idempotency-key": "p-1", plan: "Build,Ship", lease: "15m" }, { producer: "ci" });
  assert.deepEqual(named.body, { goal: "Deploy", plan: { op: "set", steps: [{ label: "Build" }, { label: "Ship" }] }, leaseSeconds: 900 });
});

test("heartbeat sends leaseSeconds within 60..3600", () => {
  assert.equal(leaseSeconds(undefined), 900);
  assert.equal(leaseSeconds("30m"), 1800);
  assert.equal(parseDuration("1h"), 3600);
  assert.throws(() => leaseSeconds("30s"), (error) => error.code === "LEASE_INVALID");
  assert.throws(() => leaseSeconds("2h"), (error) => error.code === "LEASE_INVALID");
});

test("heartbeat targets the producer's open work and echoes the lease", async () => {
  const calls = [];
  const client = { async request(method, path, options) {
    calls.push({ method, path, options });
    if (method === "GET") return { works: [{ id: "wrk_open", lifecycle: "open" }] };
    return { work: { id: "wrk_open" }, leaseUntil: "2026-10-14T09:15:00.000Z" };
  } };
  const outcome = await runScriptWork({ group: "work", action: "heartbeat", options: { producer: "ci", lease: "15m" }, dependencies: { caller: script }, client });
  assert.equal(calls[1].path, `/api/producers/${producerPathKey("ci")}/works/wrk_open/heartbeat`);
  assert.deepEqual(calls[1].options.body, { leaseSeconds: 900 });
  assert.equal(outcome.data.lease, "2026-10-14T09:15:00.000Z");
  assert.match(outcome.message, /^Lease: moving until 09:15/);
});

test("ask --wait exit codes: 0 answered, 5 denied, 8 closed or unverified, 4 still open", () => {
  assert.equal(exitCodeFor({ ok: true }), EXIT.OK);
  assert.equal(exitCodeFor({ ok: false, state: "denied" }), EXIT.NEGATIVE);
  assert.equal(exitCodeFor({ ok: false, state: "expired" }), EXIT.CLOSED);
  assert.equal(exitCodeFor({ ok: false, state: "unverified" }), EXIT.CLOSED);
  assert.equal(exitCodeFor({ ok: false, state: "timeout" }), EXIT.TERMINAL);
  assert.deepEqual(waitPlan("30m"), { waitSeconds: 1800, expiresInSeconds: 1800 });
  assert.deepEqual(waitPlan("30s"), { waitSeconds: 30, expiresInSeconds: 300 });
  assert.throws(() => waitPlan("0"), (error) => error.code === "WAIT_INVALID");
});

test("--wait 30m loops 300 s hops and exits 4 while still open", async () => {
  let now = 0; const hops = [];
  const client = { async waitForInteraction(id, seconds) { hops.push(seconds); now += seconds * 1000; return { interaction: { id, state: "pending" } }; } };
  const outcome = await waitForAnswer(client, "int_1", 1800, { now: () => now, sleep: async () => {}, env: {} });
  assert.deepEqual(hops, [300, 300, 300, 300, 300, 300]);
  assert.equal(outcome.exitCode, EXIT.TERMINAL);
});
