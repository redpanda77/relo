import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { acquireHeavySlot, parseArgs, runStep } from "./step.mjs";

const sink = () => { const lines = []; return { lines, stream: new Writable({ write(chunk, _e, done) { lines.push(String(chunk)); done(); } }) }; };
const env = () => ({ ...process.env, XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "relo-step-")) });
const run = (step, environment = env()) => { const out = sink(); const err = sink();
  return runStep(step, { env: environment, platform: "linux", stdout: out.stream, stderr: err.stream }).then((status) => ({ status, err: err.lines.join("") })); };

test("parses budgets and the command after --", () => {
  assert.deepEqual(parseArgs(["--name", "x", "--timeout", "2m", "--quiet", "30s", "--heavy", "--", "echo", "hi"]),
    { name: "x", timeoutMs: 120_000, quietMs: 30_000, heavy: true, command: ["echo", "hi"] });
  assert.throws(() => parseArgs(["--timeout", "soon", "--", "true"]), /duration/u);
  assert.throws(() => parseArgs(["--name", "x"]), /usage/u);
});

test("a step passes its exit status through and says how long it took", async () => {
  assert.equal((await run({ name: "ok", command: ["true"], timeoutMs: 10_000, quietMs: 10_000 })).status, 0);
  const failed = await run({ name: "bad", command: ["sh", "-c", "exit 3"], timeoutMs: 10_000, quietMs: 10_000 });
  assert.equal(failed.status, 3);
  assert.match(failed.err, /bad: failed \(exit 3\)/u);
});

test("over budget the whole process group is stopped: 124", async () => {
  const result = await run({ name: "slow", command: ["sh", "-c", "while true; do echo tick; sleep 0.2; done"], timeoutMs: 1_000, quietMs: 10_000 });
  assert.equal(result.status, 124);
  assert.match(result.err, /over its 1s budget/u);
});

test("a silent step (a prompt) is stopped: 125, and stdin is closed so a read fails at once", async () => {
  assert.equal((await run({ name: "silent", command: ["sleep", "30"], timeoutMs: 20_000, quietMs: 1_000 })).status, 125);
  const read = await run({ name: "prompt", command: ["sh", "-c", "read answer && echo got || exit 9"], timeoutMs: 5_000, quietMs: 5_000 });
  assert.equal(read.status, 9, "no one answers a prompt");
});

test("one heavy slot: a second heavy step waits for the first; a dead holder frees it", async () => {
  const environment = env();
  const release = await acquireHeavySlot({ env: environment });
  let second = false;
  const waiting = acquireHeavySlot({ env: environment, pollMs: 50 }).then((done) => { second = true; return done; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(second, false, "busy");
  release();
  (await waiting)();
  assert.equal(second, true);
});
