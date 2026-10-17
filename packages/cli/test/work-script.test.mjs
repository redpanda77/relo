import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { producerPathKey, resolveProducer } from "../src/script/producer.mjs";
import { parseDuration } from "../src/shared/validate.mjs";
import { leaseSeconds, runScriptWork, scriptRequests } from "../src/script/work.mjs";

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
  assert.equal(scriptRequests("heartbeat", {}, { producer: flag, work: { id: "wrk_1" } })[0].path, `/api/producers/${producerPathKey(env)}/works/wrk_1/heartbeat`);
});

test("idempotency key required when piped, generated at a TTY", () => {
  assert.throws(() => scriptRequests("start", { goal: "Deploy" }, { producer: "ci", stdinIsTTY: false }), (error) => error.code === "IDEMPOTENCY_REQUIRED");
  const [atTty] = scriptRequests("start", { goal: "Deploy" }, { producer: "ci", stdinIsTTY: true });
  assert.ok(atTty.idempotencyKey);
  const [named] = scriptRequests("start", { goal: "Deploy", "idempotency-key": "p-1", plan: "Build,Ship", lease: "15m" }, { producer: "ci" });
  assert.deepEqual(named.body, { goal: { readable: "Deploy" }, plan: { op: "set", steps: [{ label: "Build" }, { label: "Ship" }] }, leaseSeconds: 900 });
  // Sealed, the server sees no text: the goal is {sealed: true}, the plan names ids, the card and copy carry the words.
  assert.deepEqual(named.sealedForm, { goal: { sealed: true }, plan: { op: "set", steps: [{ id: "s1" }, { id: "s2" }] }, leaseSeconds: 900 });
  assert.equal(named.seal, "auto");
  assert.deepEqual(named.card, { title: "Deploy", status: undefined, stepId: "s1", phases: [{ id: "r1", steps: [{ id: "s1", label: "Build" }, { id: "s2", label: "Ship" }] }] });
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


test("update sends every plan command, one request each: text first, progress last", () => {
  const work = { id: "wrk_1", plan: { steps: [{ id: "s1", label: "Build", state: "done" }, { id: "s2", label: "Ship", state: "current" }] } };
  const requests = scriptRequests("update", { status: "Shipping", plan: "Ship,Verify", add: "Announce", progress: "2/3" }, { producer: "ci", work });
  assert.deepEqual(requests.map((request) => request.body), [
    { status: { readable: "Shipping" }, plan: { op: "set", steps: [{ id: "s2" }, { label: "Verify" }] } },
    { plan: { op: "add", steps: [{ label: "Announce" }] }, progress: { done: 2, total: 3 } },
  ]);
  assert.ok(requests.every((request) => request.method === "PATCH" && request.path.endsWith("/works/wrk_1")));
  assert.deepEqual(scriptRequests("update", { "next-step": true }, { producer: "ci", work })[0].body, { plan: { op: "next" } });
  assert.deepEqual(scriptRequests("update", { step: "ship" }, { producer: "ci", work })[0].body, { plan: { op: "step", id: "s2" } });
  assert.throws(() => scriptRequests("update", { step: "Deploy" }, { producer: "ci", work }), (error) => error.code === "STEP_NOT_FOUND");
  assert.throws(() => scriptRequests("update", { "next-step": true, step: "s2" }, { producer: "ci", work }), (error) => error.code === "REFUSED_CONTRADICTION");
});

test("pause --status sends its reason with the pause", () => {
  const requests = scriptRequests("pause", { status: "Waiting for the window" }, { producer: "ci", work: { id: "wrk_1" } });
  assert.deepEqual(requests.map((request) => [request.method, request.path.split("/").slice(-1)[0], request.body]),
    [["POST", "pause", { status: { readable: "Waiting for the window" } }]]);
});

test("a sealed script work stays sealed: every write sends ids and {sealed: true}, the card carries the words", () => {
  const work = { id: "wrk_1", sealed: true, goal: "Deploy", plan: { steps: [{ id: "s1", label: "Build", state: "current" }, { id: "s2", label: "Ship", state: "open" }] } };
  const [next] = scriptRequests("update", { "next-step": true, status: "Shipping" }, { producer: "ci", work });
  assert.equal(next.seal, "always");
  assert.deepEqual(next.sealedForm, { status: { sealed: true }, plan: { op: "next" } });
  assert.deepEqual(next.card, { title: "Deploy", status: "Shipping", stepId: "s2", phases: [{ id: "r1", steps: [{ id: "s1", label: "Build" }, { id: "s2", label: "Ship" }] }] });
  assert.deepEqual(next.copy.labels, { s1: "Build", s2: "Ship" });
  const [added] = scriptRequests("update", { add: "Announce" }, { producer: "ci", work });
  assert.deepEqual(added.sealedForm, { plan: { op: "add", steps: [{ id: "s3" }] } });
  const [finish] = scriptRequests("finish", { outcome: "Shipped" }, { producer: "ci", work });
  assert.deepEqual(finish.sealedForm, { outcome: { sealed: true }, result: "finished" });
  assert.equal(finish.card.status, "Shipped");
  const [readableWork] = scriptRequests("update", { status: "Shipping" }, { producer: "ci", work: { ...work, sealed: false } });
  assert.equal(readableWork.seal, "never", "a readable work never switches to sealed text");
});

test("a script work sends no context, so no card envelope has a handle to name (start, update, pause, finish alike)", () => {
  const work = { id: "wrk_1", sealed: true, goal: "Deploy", plan: { steps: [{ id: "s1", label: "Build", state: "current" }] } };
  const requests = [
    ...scriptRequests("start", { goal: "Deploy", plan: "Build", "idempotency-key": "k-1" }, { producer: "ci" }),
    ...scriptRequests("update", { status: "Building" }, { producer: "ci", work }),
    ...scriptRequests("pause", { status: "Waiting for the window" }, { producer: "ci", work }),
    ...scriptRequests("finish", { outcome: "Deployed" }, { producer: "ci", work }),
  ];
  for (const request of requests) {
    assert.ok(request.card, `${request.path} seals a card`);
    for (const form of [request.body, request.sealedForm]) assert.equal(form?.context, undefined, `${request.path} sends no context`);
    assert.equal(request.opaque, undefined);
  }
});
