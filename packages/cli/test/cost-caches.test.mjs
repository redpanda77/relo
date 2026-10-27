// Per-invocation cost: the caches and fast paths that keep a relo command from re-reading, re-hashing, re-fetching
// or re-sealing what it just did. Each test shows the hit (work skipped) and the miss (work redone when it must be).
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withSessionNotes } from "../src/agent/session-notes.mjs";
import { skillStamp } from "../src/install/skill.mjs";
import { dropDeviceKeys } from "../src/crypto/device-keys-cache.mjs";
import { ensureTrust } from "../src/crypto/trust.mjs";
import { rememberNames } from "../src/crypto/opaque-names.mjs";
import { selfCopyText } from "../src/crypto/self-copy.mjs";
import { declaredLane } from "../src/work/declared-lane.mjs";
import { enqueue, flush, laneIdle } from "../src/outbox/index.mjs";
import { SWEEP_EVERY_MS, sweepLocalState } from "../src/work/state-prune.mjs";
import { recordObservedEvent } from "../src/harness/core/session-state.mjs";
import { NAME_CACHE_MS, claudeCachedName } from "../src/harness/adapters/claude-code/session-name.mjs";
import { FACTS } from "../src/shared/facts.generated.mjs";

const agent = (key) => ({ type: "agent_session", harness: "claude-code", sessionId: key, sessionKey: key });
const scratch = (prefix) => mkdtemp(join(tmpdir(), `relo-cost-${prefix}-`));
const age = (path, days) => { const at = new Date(Date.now() - days * 86_400_000); utimesSync(path, at, at); };

test("skill drift: the full digest runs only when the cheap stamp changes", async () => {
  const home = await scratch("skill");
  const skill = join(home, ".claude", "skills", "relo-notifications");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: relo-notifications\nmetadata:\n  version: 0.0.1\n---\n");
  await writeFile(join(skill, "VERSION"), "0.0.1\n");
  const deps = (key) => ({ caller: agent(key), env: { RELO_STATE_DIR: home, HOME: home }, home, version: "9.9.9" });
  const place = { env: deps("x").env, home, cliVersion: "9.9.9" };
  const before = skillStamp(place);
  assert.equal(skillStamp(place), before, "an unchanged install has a stable stamp");

  const first = await withSessionNotes({ command: "activity.update" }, deps("a1"));
  assert.match(first.notes[0], /9\.9\.9/u);
  const cachePath = join(home, "hooks", "skill-drift.json");
  const cached = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.equal(cached.stamp, before);

  // A hit: the verdict comes from the cache (a marker only the cache holds proves the digest did not run).
  writeFileSync(cachePath, JSON.stringify({ ...cached, hint: "from the cache" }));
  const hit = await withSessionNotes({ command: "activity.update" }, deps("a2"));
  assert.deepEqual(hit.notes, ["from the cache"]);

  // A miss: SKILL.md changes size, the stamp moves, and the digest decides again.
  await writeFile(join(skill, "SKILL.md"), "---\nname: relo-notifications\nmetadata:\n  version: 0.0.1\n---\nedited\n");
  assert.notEqual(skillStamp(place), before);
  const miss = await withSessionNotes({ command: "activity.update" }, deps("a3"));
  assert.match(miss.notes[0], /9\.9\.9/u);
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).hint, miss.notes[0]);
  // A different CLI version is a different stamp too.
  assert.notEqual(skillStamp({ ...place, cliVersion: "9.9.10" }), skillStamp(place));
});

function trustHarness(ttl) {
  return mkdtemp(join(tmpdir(), "relo-cost-keys-")).then((folder) => {
    const calls = { list: 0 };
    const clock = { now: 1_800_000_000_000 };
    const dependencies = { env: { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state"), },
      configPath: () => join(folder, "config.json"), now: () => clock.now, deviceKeysTtlMs: ttl };
    const client = { publishClientKey: async () => ({}), listDeviceKeys: async () => { calls.list += 1; return { devices: [] }; } };
    const config = { apiUrl: "https://relo.internal", token: "t".repeat(44) };
    return { calls, clock, dependencies, client, config, ensure: (extra = {}) => ensureTrust({ client, config, dependencies, ...extra }) };
  });
}

test("device keys: the seal path reuses the listing for the TTL, then asks again; keys commands never use it", async () => {
  const h = await trustHarness(60_000);
  await h.ensure();
  await h.ensure();
  assert.equal(h.calls.list, 1, "the second sealed write reuses the listing");
  h.clock.now += 59_000;
  await h.ensure();
  assert.equal(h.calls.list, 1, "still inside the 60 s window");
  h.clock.now += 2_000;
  await h.ensure();
  assert.equal(h.calls.list, 2, "older than the window: refetched");
  await h.ensure({ details: true });
  assert.equal(h.calls.list, 3, "relo keys ... always asks the server");
  await h.ensure();
  assert.equal(h.calls.list, 3, "the details fetch did not refresh what the seal path trusts");
  await dropDeviceKeys(h.dependencies);
  await h.ensure();
  assert.equal(h.calls.list, 4, "a dropped cache (a 4xx, a sealing failure) refetches");
});

test("device keys: TTL 0 turns the cache off", async () => {
  const h = await trustHarness(0);
  await h.ensure();
  await h.ensure();
  assert.equal(h.calls.list, 2);
});

test("declared lane: an empty lane drains with one readdir (no lock, no folder); work commands never claim hook snapshots", async () => {
  const outbox = join(await scratch("outbox"), "outbox");
  const client = { apiUrl: "https://relo.test", request: async () => { throw new Error("nothing is sent"); } };
  const lane = declaredLane({ client, config: { apiUrl: "https://relo.test" }, dependencies: { outboxDirectory: outbox }, identity: { sessionKey: "s1", harness: "claude-code" }, sealer: async () => null });
  assert.equal(await laneIdle({ directory: outbox, lane: "declared" }), true);
  assert.deepEqual(await lane.drain(), { sent: 0, pending: 0 });
  assert.equal(existsSync(outbox), false, "no lock or lane folder was created");

  // A pending hook snapshot stays exactly where it is while the declared lane is empty or flushed alone.
  await enqueue({ directory: outbox, lane: "observed", entry: { server: "https://relo.test", route: "/api/agent-sessions/observed", method: "POST",
    body: { x: 1 }, idempotencyKey: "k1", credential: "harness", sessionKey: "s1" } });
  const sent = [];
  await enqueue({ directory: outbox, lane: "declared", entry: { server: "https://relo.test", route: "/api/works/w/update", method: "PATCH",
    body: { v: 1 }, idempotencyKey: "k2", credential: "cli", sessionKey: "s1" } });
  assert.equal(await laneIdle({ directory: outbox, lane: "declared" }), false);
  const result = await flush({ directory: outbox, server: "https://relo.test", lanes: ["declared"], send: async (entry) => { sent.push(entry.idempotencyKey); return { status: 200 }; } });
  assert.deepEqual(sent, ["k2"], "only the declared entry is offered to the sender");
  assert.equal(result.declared, 0);
  assert.equal(await laneIdle({ directory: outbox, lane: "observed" }), false, "the observed snapshot is still queued, never renamed away");
});

test("self copy: labels and details are kept for the newest rounds only, round titles for all", () => {
  const keep = FACTS.work.planRoundsWithSteps;
  const total = keep + 3;
  const rounds = Array.from({ length: total }, (_, index) => ({ n: index + 1, state: "closed", title: `Round ${index + 1}` }));
  const steps = rounds.map((round) => ({ id: `s${round.n}`, round: round.n, label: `Step of ${round.n}`, detail: `why ${round.n}` }));
  const text = selfCopyText({ goal: "g", plan: { rounds, steps } });
  assert.deepEqual(Object.keys(text.labels), steps.slice(-keep).map((step) => step.id));
  assert.deepEqual(Object.keys(text.details), steps.slice(-keep).map((step) => step.id));
  assert.equal(Object.keys(text.rounds).length, total, "every round keeps its title");
  // No rounds listed: one round, everything kept.
  assert.deepEqual(Object.keys(selfCopyText({ plan: { steps: [{ id: "s1", label: "a" }, { id: "s2", label: "b" }] } }).labels), ["s1", "s2"]);
});

test("names.json is not rewritten when nothing changed", async () => {
  const state = await scratch("names");
  const place = { env: { RELO_STATE_DIR: state } };
  await rememberNames(place, { "p-aaaaaaaaaaaaaaaa": "Alpha" });
  const path = join(state, "names.json");
  age(path, 3);
  const stamp = statSync(path).mtimeMs;
  await rememberNames(place, { "p-aaaaaaaaaaaaaaaa": "Alpha" });
  assert.equal(statSync(path).mtimeMs, stamp, "same names: no rewrite");
  await rememberNames(place, { "p-bbbbbbbbbbbbbbbb": "Beta" });
  assert.notEqual(statSync(path).mtimeMs, stamp);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["p-aaaaaaaaaaaaaaaa", "p-bbbbbbbbbbbbbbbb"]);
});

test("the local-state sweep runs once per window; it prunes old replay fences and sealed-card caches", async () => {
  const state = await scratch("sweep");
  const deps = { env: { RELO_STATE_DIR: state }, home: state };
  const sessions = join(state, "sessions");
  const put = (path, days) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "{}"); age(path, days); };
  put(join(state, "activity-commands", "ab", "old.json"), 40);
  put(join(state, "activity-commands", "ab", "new.json"), 1);
  put(join(state, "sealed-cards", "old.json"), 20);
  put(join(state, "sealed-cards", "new.json"), 2);
  const now = Date.now();
  assert.equal(await sweepLocalState(deps, sessions, now), true);
  assert.equal(existsSync(join(state, "activity-commands", "ab", "old.json")), false);
  assert.equal(existsSync(join(state, "activity-commands", "ab", "new.json")), true);
  assert.equal(existsSync(join(state, "sealed-cards", "old.json")), false);
  assert.equal(existsSync(join(state, "sealed-cards", "new.json")), true);
  put(join(state, "sealed-cards", "old2.json"), 20);
  assert.equal(await sweepLocalState(deps, sessions, now + 1_000), false, "inside the window: no scan");
  assert.equal(existsSync(join(state, "sealed-cards", "old2.json")), true);
  assert.equal(await sweepLocalState(deps, sessions, now + SWEEP_EVERY_MS + 1_000), true);
  assert.equal(existsSync(join(state, "sealed-cards", "old2.json")), false);
});

test("observed state: a write that only moves lastSeenAt within 15 s is skipped", async () => {
  const directory = await scratch("observed");
  const session = "sess1";
  const at = (ms) => new Date(1_800_000_000_000 + ms).toISOString();
  const state = (ms, extra = {}) => ({ v: 1, session, phase: "working", lastSeenAt: at(ms), ...extra });
  const record = (next) => recordObservedEvent(directory, session, { event: { event: "x" }, now: 0 }, async () => ({ state: next }));
  const file = join(directory, `${session}.json`);
  await record(state(0));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).lastSeenAt, at(0));
  await record(state(5_000));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).lastSeenAt, at(0), "5 s later, nothing else changed: not rewritten");
  await record(state(6_000, { phase: "stopped" }));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).phase, "stopped", "a real change is written at once");
  await record(state(30_000, { phase: "stopped" }));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).lastSeenAt, at(30_000), "past 15 s the clock is written");
});

test("session name: the resolved folder and title are reused while the transcript is unchanged, for at most 5 minutes", async () => {
  const root = await scratch("name");
  const cwd = join(root, "work");
  const id = "11111111-2222-3333-4444-555555555555";
  const directory = join(root, "claude", "projects", cwd.replace(/[^A-Za-z0-9]/gu, "-"));
  mkdirSync(directory, { recursive: true });
  const transcript = join(directory, `${id}.jsonl`);
  const titled = (title) => `${JSON.stringify({ type: "custom-title", customTitle: title })}\n`;
  writeFileSync(transcript, titled("Alpha work"));
  const fixed = new Date(1_700_000_000_000);
  utimesSync(transcript, fixed, fixed);
  const ask = (nameCache, now) => claudeCachedName({ sessionId: id, env: { CLAUDE_CONFIG_DIR: join(root, "claude") }, home: root, cwd, nameCache, now });
  const first = ask(undefined, 1_000);
  assert.equal(first.title, "Alpha work");
  assert.equal(first.cache.directory, directory);
  // Same size and mtime, different text: only a cache hit still says "Alpha work".
  writeFileSync(transcript, titled("Bravo work"));
  utimesSync(transcript, fixed, fixed);
  assert.equal(ask(first.cache, 2_000).title, "Alpha work", "unchanged stamp: no re-read");
  assert.equal(ask(first.cache, 1_000 + NAME_CACHE_MS + 1).title, "Bravo work", "past 5 minutes: read again");
  // A changed transcript (size) is a miss at once.
  writeFileSync(transcript, titled("Charlie the third"));
  assert.equal(ask(first.cache, 3_000).title, "Charlie the third");
});
