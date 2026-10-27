import "./hermetic-env.mjs";
// The Relo MCP server as an observed source: it lives exactly as long as its harness, so when its client closes stdin
// and the harness process is gone it ends that harness's sessions at once (reason "mcp"); a /mcp reconnect (stdin closes,
// the harness lives) ends nothing. While it runs it also drives the throttled liveness sweep once a minute.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
import { adapterFor } from "../src/harness/adapters/index.mjs";
import { run } from "../src/cli.mjs";
import { endProcessSessions } from "../src/harness/entry.mjs";
import { sweepGoneSessions } from "../src/harness/core/sweep.mjs";
import { hookBox } from "./hook-fixture.mjs";

const OTHER = "11111111-2222-4333-8444-555555555555";
const HARNESS = 4242;
const ELSEWHERE = 5151;

// Each hook reports its own parent pid; the probe says a noted process is the harness's own, and whether it lives.
async function twoHarnesses({ alive = true } = {}) {
  const box = await hookBox();
  const probe = { findHarnessProcess: async ({ startPid }) => ({ pid: startPid, start: "Sat Oct 17 10:00:00 2026" }), processAlive: async () => alive };
  const base = box.deps;
  let parentPid = HARNESS;
  box.deps = () => ({ ...base(), harnessProcess: probe, get parentPid() { return parentPid; } });
  await box.event("SessionStart", "start", { source: "startup" });
  parentPid = ELSEWHERE;
  await box.event("SessionStart", "start", { source: "startup", session_id: OTHER });
  parentPid = HARNESS;
  return box;
}

const records = async (box) => {
  const directory = join(box.state, "observed");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json") && !name.startsWith("."));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
};
// Phase by the noted process of each session (a hook notes its parent pid): { 4242: ..., 5151: ... }.
const phases = async (box) => Object.fromEntries((await records(box)).map((state) => [state.harnessCandidate, state.phase]));

const resolveAll = (box) => sweepGoneSessions({ adapterFor, intervalMs: 0, dependencies: { env: {}, accountProbes: {}, ...box.deps(), observedStateDirectory: join(box.state, "observed"), outboxDirectory: box.outbox } });

/** `relo mcp` whose client closes stdin at once, in a harness whose pid is `parentPid` and which is `alive` or not. */
async function leave(box, { parentPid = HARNESS, alive }) {
  const stdin = new PassThrough();
  stdin.end();
  const base = box.deps();
  await run(["mcp"], { stdin, mcpOutput: { write() {} }, mcpLeaveGraceMs: 5, mcpTickMs: 60_000 },
    { ...base, parentPid, harnessProcess: { ...base.harnessProcess, processAlive: async () => alive } });
  await box.collect();
}

test("a dead parent ends the sessions of that harness, queues their ended snapshots with reason mcp, and starts a flusher", async () => {
  const box = await twoHarnesses();
  await resolveAll(box);
  const before = box.spawned;
  await leave(box, { alive: false });
  const now = await phases(box);
  assert.equal(now[HARNESS], "ended");
  assert.equal(now[ELSEWHERE], "open", "a session of another harness process is untouched");
  const ended = box.sent.filter((body) => body.phase === "ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].endReason, "mcp");
  assert.ok(box.spawned > before, "no flusher runs in the MCP server, so the leave starts one");
  assert.equal(JSON.stringify(box.sent).includes(String(HARNESS)), false, "the pid never leaves the computer");
});

test("a live parent after stdin closes (a /mcp reconnect) ends nothing", async () => {
  const box = await twoHarnesses();
  await resolveAll(box);
  const sent = box.sent.length;
  await leave(box, { alive: true });
  assert.deepEqual(await phases(box), { [HARNESS]: "open", [ELSEWHERE]: "open" });
  assert.equal(box.sent.length, sent);
});

test("without the MCP server nothing ends, and a leave for no process ends nothing", async () => {
  const box = await twoHarnesses({ alive: true });
  await resolveAll(box);
  assert.deepEqual(await phases(box), { [HARNESS]: "open", [ELSEWHERE]: "open" });
  assert.deepEqual(await endProcessSessions({ pid: undefined }, box.deps()), []);
  assert.deepEqual(await endProcessSessions({ pid: 1 }, box.deps()), []);
  assert.deepEqual(await phases(box), { [HARNESS]: "open", [ELSEWHERE]: "open" });
});

test("a session whose process the sweep has not resolved yet ends by its noted process; another pid's does not", async () => {
  const box = await twoHarnesses();
  const ended = await endProcessSessions({ pid: HARNESS }, box.deps());
  assert.equal(ended.length, 1);
  assert.equal((await phases(box))[ELSEWHERE], "open");
  assert.deepEqual(await endProcessSessions({ pid: HARNESS }, box.deps()), [], "an ended session is not ended twice");
});

test("a session resumed in another process is not ended by the old process's leave", async () => {
  const box = await twoHarnesses();
  await resolveAll(box);
  const base = box.deps;
  box.deps = () => ({ ...base(), parentPid: 9999 });
  await box.event("SessionStart", "start", { source: "resume" });
  assert.deepEqual(await endProcessSessions({ pid: HARNESS }, box.deps()), []);
});

test("while it runs, the MCP server drives the throttled liveness sweep, and the flusher it starts sends the end", async () => {
  const box = await twoHarnesses({ alive: false });
  await resolveAll(box);
  box.clock += 120_000;
  const stdin = new PassThrough();
  const base = box.deps();
  const server = run(["mcp"], { stdin, mcpOutput: { write() {} }, mcpLeaveGraceMs: 5, mcpTickMs: 20 },
    { ...base, parentPid: 31337, harnessProcess: { ...base.harnessProcess, processAlive: async ({ pid }) => pid === 31337 } });
  for (let waited = 0; waited < 15_000 && Object.values(await phases(box)).includes("open"); waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
  stdin.end();
  await server;
  await box.collect();
  assert.deepEqual(await phases(box), { [HARNESS]: "ended", [ELSEWHERE]: "ended" });
  assert.deepEqual(box.sent.filter((body) => body.phase === "ended").map((body) => body.endReason), ["gone", "gone"]);
});

test("a hangup does not end the MCP server before its leave: SIGHUP is ignored while it serves, EOF ends it", { skip: process.platform === "win32" && "POSIX signals: Windows has no SIGHUP, and child.kill(SIGHUP) terminates the process outright" }, async () => {
  // In process: the handler exists exactly while serving.
  const box = await twoHarnesses();
  await resolveAll(box);
  const before = process.listenerCount("SIGHUP");
  const stdin = new PassThrough();
  const base = box.deps();
  const server = run(["mcp"], { stdin, mcpOutput: { write() {} }, mcpLeaveGraceMs: 5, mcpTickMs: 60_000 },
    { ...base, parentPid: HARNESS, harnessProcess: { ...base.harnessProcess, processAlive: async () => false } });
  for (let waited = 0; waited < 15_000 && process.listenerCount("SIGHUP") === before; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(process.listenerCount("SIGHUP"), before + 1);
  stdin.end();
  await server;
  assert.equal(process.listenerCount("SIGHUP"), before);
  await box.collect();
  assert.equal((await phases(box))[HARNESS], "ended", "EOF after the hangup still runs the leave");
  // A real process survives SIGHUP and exits 0 on EOF.
  const home = mkdtempSync(join(tmpdir(), "relo-hup-"));
  const bin = fileURLToPath(new URL("../bin/relo.mjs", import.meta.url));
  const child = spawn(process.execPath, [bin, "mcp"], { env: { ...process.env, HOME: home, RELO_STATE_DIR: join(home, "state"), RELO_NO_BACKGROUND_FLUSH: "1", RELO_NO_UPDATE_CHECK: "1" }, stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  // Served once it answers an initialize request (not a guess at how long node takes to start on a busy machine).
  const ready = new Promise((resolve) => child.stdout.once("data", resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })}\n`);
  await Promise.race([ready, exited.then((result) => { throw new Error(`relo mcp exited before it answered: ${JSON.stringify(result)}`); })]);
  child.kill("SIGHUP");
  const early = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(undefined), 400))]);
  assert.equal(early, undefined, "still serving after SIGHUP");
  child.stdin.end();
  const result = await exited;
  assert.deepEqual(result, { code: 0, signal: null });
});
