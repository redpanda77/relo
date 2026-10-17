import "./hermetic-env.mjs";
// The durable outbox (EDGE.3): offline writes are queued, flushed in order, never reordered; the observed
// lane keeps only the latest snapshot per session; permanent refusals are recorded, not retried.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STALE_LOCK_MS, discard, enqueue, flush, isFlushing, pending, serverOrigin } from "../src/outbox/index.mjs";

const SERVER = "https://relo.example.test";
const dir = () => mkdtemp(join(tmpdir(), "relo-outbox-"));
const declared = (n) => ({ server: SERVER, route: "/api/session/works", method: "POST", body: { n }, idempotencyKey: `k-${n}`, credential: "cli" });
const observed = (session, seq) => ({ server: SERVER, route: "/api/agent-sessions/observed", method: "POST", body: { session, seq }, idempotencyKey: `o-${session}-${seq}`,
  credential: "harness", sessionKey: session });
const recorder = (respond = () => ({ status: 200 })) => {
  const seen = [];
  const send = async (entry) => { seen.push(entry); return respond(entry, seen.length); };
  return { seen, send };
};

test("declared entries are sent strictly in order, each once, and survive a restart (files on disk)", async () => {
  const directory = await dir();
  let clock = 1_000;
  for (let n = 1; n <= 5; n += 1) await enqueue({ directory, lane: "declared", entry: declared(n), now: clock++ });
  // A "restart": nothing in memory, only the directory.
  assert.equal((await pending({ directory })).declared, 5);
  const { seen, send } = recorder();
  const out = await flush({ directory, send, server: SERVER });
  assert.deepEqual(seen.map((entry) => entry.body.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(seen.map((entry) => entry.idempotencyKey), ["k-1", "k-2", "k-3", "k-4", "k-5"]);
  assert.deepEqual(out, { sent: 5, pending: 0, dead: 0 });
  assert.equal((await flush({ directory, send, server: SERVER })).sent, 0, "nothing is sent twice");
});

test("declared entries enqueued in the same millisecond keep their order", async () => {
  const directory = await dir();
  for (let n = 1; n <= 20; n += 1) await enqueue({ directory, lane: "declared", entry: declared(n), now: 5_000 });
  const { seen, send } = recorder();
  await flush({ directory, send, server: SERVER });
  assert.deepEqual(seen.map((entry) => entry.body.n), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("observed lane: a newer snapshot for the same session replaces the pending one; sessions are independent", async () => {
  const directory = await dir();
  await enqueue({ directory, lane: "observed", entry: observed("a", 1), now: 1 });
  await enqueue({ directory, lane: "observed", entry: observed("b", 1), now: 2 });
  await enqueue({ directory, lane: "observed", entry: observed("a", 2), now: 3 });
  await enqueue({ directory, lane: "observed", entry: observed("a", 3), now: 4 });
  assert.equal((await pending({ directory })).observed, 2);
  const { seen, send } = recorder();
  await flush({ directory, send, server: SERVER });
  assert.deepEqual(seen.map((entry) => `${entry.body.session}${entry.body.seq}`), ["b1", "a3"], "oldest first, latest wins");
});

test("a network failure stops the lane and keeps order; the next flush resumes from the same entry", async () => {
  const directory = await dir();
  for (let n = 1; n <= 3; n += 1) await enqueue({ directory, lane: "declared", entry: declared(n), now: n });
  let down = true;
  const { seen, send } = recorder((entry) => {
    if (down && entry.body.n === 2) throw new TypeError("fetch failed");
    return { status: 201 };
  });
  const first = await flush({ directory, send, server: SERVER });
  assert.deepEqual(first, { sent: 1, pending: 2, dead: 0 });
  assert.deepEqual(seen.map((entry) => entry.body.n), [1, 2], "3 was never tried past the failure");
  down = false;
  await flush({ directory, send, server: SERVER });
  assert.deepEqual(seen.map((entry) => entry.body.n), [1, 2, 2, 3]);
  assert.equal((await pending({ directory })).total, 0);
});

test("5xx, 408 and 429 are retried later; another 4xx is dropped into dead.json with its reason", async () => {
  const directory = await dir();
  for (let n = 1; n <= 3; n += 1) await enqueue({ directory, lane: "declared", entry: declared(n), now: n });
  const status = { 1: 422, 2: 503 };
  const { send } = recorder((entry) => {
    const code = status[entry.body.n];
    if (code) throw Object.assign(new Error("refused"), { status: code });
    return { status: 200 };
  });
  const out = await flush({ directory, send, server: SERVER });
  assert.deepEqual(out, { sent: 0, pending: 2, dead: 1 });
  const dead = JSON.parse(await readFile(join(directory, "dead.json"), "utf8"));
  assert.equal(dead.length, 1);
  assert.equal(dead[0].status, 422);
  assert.equal(dead[0].route, "/api/session/works");
  assert.match(dead[0].reason, /422/u);
  assert.equal(JSON.stringify(dead).includes("idempotencyKey"), false, "only the reason is kept, not the body");
  for (const code of [408, 429, 500]) {
    status[2] = code;
    assert.equal((await flush({ directory, send, server: SERVER })).pending, 2, `${code} keeps the entry`);
  }
  delete status[2];
  assert.deepEqual(await flush({ directory, send, server: SERVER }), { sent: 2, pending: 0, dead: 0 });
  assert.equal((await pending({ directory })).dead.length, 1);
});

test("one lane failing does not hold up the other", async () => {
  const directory = await dir();
  await enqueue({ directory, lane: "observed", entry: observed("a", 1), now: 1 });
  await enqueue({ directory, lane: "declared", entry: declared(1), now: 2 });
  const { seen, send } = recorder((entry) => {
    if (entry.credential === "harness") throw new TypeError("fetch failed");
    return { status: 200 };
  });
  await flush({ directory, send, server: SERVER });
  assert.deepEqual(seen.map((entry) => entry.credential), ["harness", "cli"]);
  assert.deepEqual((await pending({ directory })), { observed: 1, declared: 0, total: 1, oldestAt: new Date(1).toISOString(), dead: [] });
});

test("a snapshot enqueued while the older one is in flight is not lost, and a failed older one yields to it", async () => {
  const directory = await dir();
  await enqueue({ directory, lane: "observed", entry: observed("a", 1), now: 1 });
  const { seen, send } = recorder(async (entry) => {
    if (entry.body.seq === 1) {
      await enqueue({ directory, lane: "observed", entry: observed("a", 2), now: 2 });
      throw new TypeError("fetch failed");
    }
    return { status: 200 };
  });
  await flush({ directory, send, server: SERVER });
  assert.deepEqual(seen.map((entry) => entry.body.seq), [1]);
  await flush({ directory, send, server: SERVER });
  assert.deepEqual(seen.map((entry) => entry.body.seq), [1, 2], "seq 1 was dropped in favour of seq 2, never resent after it");
});

test("one flusher at a time: a live lock makes flush return at once; a stale or dead one is recovered", async () => {
  const directory = await dir();
  await enqueue({ directory, lane: "declared", entry: declared(1), now: 1 });
  await writeFile(join(directory, "flush.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: "other" }));
  assert.equal(await isFlushing({ directory }), true);
  const { seen, send } = recorder();
  assert.deepEqual(await flush({ directory, send, server: SERVER }), { sent: 0, pending: 1, dead: 0, locked: true });
  assert.equal(seen.length, 0);
  await writeFile(join(directory, "flush.lock"), JSON.stringify({ pid: process.pid, at: new Date(Date.now() - STALE_LOCK_MS - 1).toISOString(), token: "old" }));
  assert.equal(await isFlushing({ directory }), false);
  assert.equal((await flush({ directory, send, server: SERVER })).sent, 1, "a stale lock is taken over");
  await enqueue({ directory, lane: "declared", entry: declared(2), now: 2 });
  await writeFile(join(directory, "flush.lock"), JSON.stringify({ pid: 999_999_999, at: new Date().toISOString(), token: "dead" }));
  assert.equal((await flush({ directory, send, server: SERVER })).sent, 1, "a lock whose process is gone is taken over");
  assert.equal(existsSync(join(directory, "flush.lock")), false, "released after the flush");
});

test("two concurrent flushes never send an entry twice", async () => {
  const directory = await dir();
  for (let n = 1; n <= 10; n += 1) await enqueue({ directory, lane: "declared", entry: declared(n), now: n });
  const { seen, send } = recorder(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); return { status: 200 }; });
  await Promise.all([flush({ directory, send, server: SERVER }), flush({ directory, send, server: SERVER }), flush({ directory, send, server: SERVER })]);
  assert.deepEqual(seen.map((entry) => entry.body.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("an entry left in flight by a crashed flusher goes back in the queue", async () => {
  const directory = await dir();
  await enqueue({ directory, lane: "declared", entry: declared(1), now: 1 });
  const [name] = (await readdir(join(directory, "declared"))).filter((file) => file.endsWith(".json"));
  const { rename } = await import("node:fs/promises");
  await rename(join(directory, "declared", name), join(directory, "declared", `.inflight-${name}`));
  const { seen, send } = recorder();
  await flush({ directory, send, server: SERVER });
  assert.equal(seen.length, 1);
});

test("the budget stops a flush between entries; enqueue validates; discard empties a lane", async () => {
  const directory = await dir();
  for (let n = 1; n <= 3; n += 1) await enqueue({ directory, lane: "declared", entry: declared(n), now: n });
  let clock = 0;
  const { send } = recorder(() => { clock += 600; return { status: 200 }; });
  assert.deepEqual(await flush({ directory, send, server: SERVER, budgetMs: 1_000, now: () => clock }), { sent: 2, pending: 1, dead: 0 });
  await assert.rejects(enqueue({ directory, lane: "other", entry: declared(1) }), /lane/u);
  await assert.rejects(enqueue({ directory, lane: "observed", entry: declared(1) }), /sessionKey/u);
  await assert.rejects(enqueue({ directory, lane: "declared", entry: { ...declared(1), credential: "root" } }), /credential/u);
  await assert.rejects(enqueue({ directory, lane: "declared", entry: { ...declared(1), route: "https://elsewhere/x" } }), /route/u);
  await enqueue({ directory, lane: "observed", entry: observed("a", 1) });
  assert.equal(await discard({ directory, lane: "observed" }), 1);
  assert.equal((await pending({ directory })).observed, 0);
  assert.equal((await pending({ directory })).declared, 1, "discard touches only its lane");
});

test("meta travels with the entry to the sender", async () => {
  const directory = await dir();
  await enqueue({ directory, lane: "observed", entry: { ...observed("a", 1), meta: { names: { "p-x": "relo" } } } });
  const { seen, send } = recorder();
  await flush({ directory, send, server: SERVER });
  assert.deepEqual(seen[0].meta, { names: { "p-x": "relo" } });
});

test("an entry queued for one server is never sent by a flush for another: it is dead with that reason", async () => {
  const directory = await dir();
  const other = "https://relo-other.example.test";
  await enqueue({ directory, lane: "declared", entry: { ...declared(1), server: `${other}/` }, now: 1 });
  await enqueue({ directory, lane: "observed", entry: { ...observed("a", 1), server: other }, now: 2 });
  await enqueue({ directory, lane: "declared", entry: declared(2), now: 3 });
  const { seen, send } = recorder();
  assert.deepEqual(await flush({ directory, send, server: `${SERVER}/` }), { sent: 1, pending: 0, dead: 2 });
  assert.deepEqual(seen.map((entry) => `${entry.server} ${entry.body.n}`), [`${SERVER} 2`], "only this server's entry goes out");
  const dead = JSON.parse(await readFile(join(directory, "dead.json"), "utf8"));
  assert.deepEqual(dead.map((item) => [item.lane, item.reason]), [["observed", "queued for another server"], ["declared", "queued for another server"]]);
  assert.equal((await pending({ directory })).total, 0, "removed, never retried");
});

test("an entry without a server (written before servers were recorded) is never sent; enqueue and flush require one", async () => {
  const directory = await dir();
  await mkdir(join(directory, "declared"), { recursive: true });
  const { server: _, ...old } = declared(1);
  await writeFile(join(directory, "declared", "000000000000001-000001-aaaaaaaa.json"),
    JSON.stringify({ v: 1, lane: "declared", enqueuedAt: new Date(1).toISOString(), entry: { ...old, method: "POST" } }));
  const { seen, send } = recorder();
  assert.deepEqual(await flush({ directory, send, server: SERVER }), { sent: 0, pending: 0, dead: 1 });
  assert.equal(seen.length, 0);
  assert.equal((await pending({ directory })).dead[0].reason, "queued for another server");
  await assert.rejects(enqueue({ directory, lane: "declared", entry: old }), /server/u);
  await assert.rejects(enqueue({ directory, lane: "declared", entry: { ...old, server: "not a url" } }), /server/u);
  await assert.rejects(flush({ directory, send }), /server/u);
  assert.equal(serverOrigin("https://relo.example.test/"), "https://relo.example.test");
});

test("the dead list is the last 7 days: older entries age out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-outbox-dead-"));
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  const old = { at: "2026-10-14T12:00:00.000Z", lane: "declared", route: "/api/session/works/current", reason: "queued for another server" };
  const fresh = { ...old, at: "2026-10-21T12:00:00.000Z" };
  await writeFile(join(directory, "dead.json"), JSON.stringify([old, fresh]));
  assert.deepEqual((await pending({ directory, now })).dead, [fresh]);
});

test("a lane the server rate-limited waits for Retry-After before it sends again, in order", async () => {
  const directory = await dir();
  for (let n = 1; n <= 2; n += 1) await enqueue({ directory, lane: "declared", entry: declared(n), now: n });
  let limited = true;
  let clock = 1_000_000;
  const { seen, send } = recorder(() => {
    if (limited) throw Object.assign(new Error("rate limited"), { status: 429, details: { status: 429, retryAfterSeconds: 30 } });
    return { status: 200 };
  });
  assert.equal((await flush({ directory, send, server: SERVER, now: () => clock })).pending, 2);
  assert.equal(seen.length, 1, "stops at the first refusal");
  limited = false;
  clock += 10_000;
  assert.equal((await flush({ directory, send, server: SERVER, now: () => clock })).pending, 2, "still waiting: nothing sent");
  assert.equal(seen.length, 1);
  clock += 21_000;
  assert.equal((await flush({ directory, send, server: SERVER, now: () => clock })).pending, 0);
  assert.deepEqual(seen.map((entry) => entry.body.n), [1, 1, 2]);
});
