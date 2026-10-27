// What a command pays for at startup, measured in a real spawned process (the in-process hook test in
// harness-invariants runs with a warm module cache and cannot see this). A hook runs on every tool call,
// so what it loads is a budget: bin/relo.mjs sends it straight to harness/entry.mjs with the hook
// dependencies only, and sealing, labels and the flusher's child_process load only when used.
import "./hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

// module-counter.mjs uses module.registerHooks (Node 22.15+); CI runs a newer Node 22 than some developer machines.
const NO_COUNTER = typeof nodeModule.registerHooks !== "function" && "needs module.registerHooks (Node >= 22.15) for the module counter";
const BIN = fileURLToPath(new URL("../bin/relo.mjs", import.meta.url));
const COUNTER = new URL("./module-counter.mjs", import.meta.url).href; // --import needs a file: URL on Windows

// The hook reads its config, which checks the server address with the shared origin rule (origin.generated.mjs).
// 38: shared/settings.mjs (dependency-free) is the one place a variable is read (RELO_PROFILE, RELO_COMPUTER).
// 40: the OpenCode adapter (its descriptor and module), registered beside Claude Code and Gemini CLI.
// The turn hook adds one module (harness/core/turn.mjs, loaded only for that role) to read the open work.
// The status line wrapper reads a few local files and runs the owner's command (child_process loads only then); the
// snapshot path (process.mjs, the adapters) loads only when a reading moved enough to send.
// 41: the turn hook and the status line reach one more shared module (context size from hooks).
// 36/37: a hook loads only its own harness's adapter (harness/adapters/load.mjs), not every adapter.
// 39/40: plus Windows' hardening on the write path: the hook command's launch form, atomic writes and private folders.
const CEILINGS = { hook: 39, turn: 40, statusline: 40, version: 2 };
// What a hook must never load: the command dispatcher, the caller and harness catalog, sealing, and the
// producer and owner modules.
const HOOK_NEVER = [/^src\/cli\.mjs$/u, /^src\/deps\.mjs$/u, /^src\/caller\.mjs$/u, /^src\/harness\/catalog\.mjs$/u, /^src\/crypto\//u,
  /^src\/(agent|script|owner|commands|messages)\//u, /^src\/(args|schema|help|output|suggest)\.mjs$/u];

function spawn(argv, input) {
  const home = mkdtempSync(join(tmpdir(), "relo-startup-"));
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), RELO_STATE_DIR: join(home, "state"),
    RELO_NO_BACKGROUND_FLUSH: "1", RELO_NO_UPDATE_CHECK: "1" };
  const started = performance.now();
  const child = spawnSync(process.execPath, ["--import", COUNTER, BIN, ...argv], {
    cwd: repo, env, input: input === undefined ? "" : JSON.stringify({ ...input, cwd: repo }), encoding: "utf8",
  });
  const elapsed = performance.now() - started;
  const report = child.stderr.split("\n").filter((line) => line.startsWith('{"reloModules"')).at(-1);
  assert.ok(report, `no module report from relo ${argv.join(" ")}: ${child.stderr}`);
  return { status: child.status, modules: JSON.parse(report).reloModules, elapsed };
}

const HOOK_INPUT = { session_id: "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c001", hook_event_name: "PreToolUse", tool_use_id: "t1", tool_name: "Bash" };

test("a hook loads no more modules than its budget", { skip: NO_COUNTER }, () => {
  const run = spawn(["hook", "tool-start", "--agent", "claude-code"], HOOK_INPUT);
  assert.equal(run.status, 0);
  assert.ok(run.modules.length <= CEILINGS.hook, `relo hook loaded ${run.modules.length} modules (budget ${CEILINGS.hook}):\n${run.modules.join("\n")}`);
  for (const module of run.modules) for (const pattern of HOOK_NEVER) assert.doesNotMatch(module, pattern, `relo hook loaded ${module}`);
});

test("the turn hook (UserPromptSubmit context) stays local: one module over a hook, none of the forbidden ones", { skip: NO_COUNTER }, () => {
  const run = spawn(["hook", "turn", "--agent", "claude-code"], { session_id: HOOK_INPUT.session_id, hook_event_name: "UserPromptSubmit" });
  assert.equal(run.status, 0);
  assert.ok(run.modules.length <= CEILINGS.turn, `relo hook turn loaded ${run.modules.length} modules (budget ${CEILINGS.turn}):\n${run.modules.join("\n")}`);
  for (const module of run.modules) for (const pattern of HOOK_NEVER) assert.doesNotMatch(module, pattern, `relo hook turn loaded ${module}`);
});

test("the status line wrapper stays local: a small module count, none of the forbidden ones", { skip: NO_COUNTER }, () => {
  const run = spawn(["statusline"], { session_id: HOOK_INPUT.session_id });
  assert.equal(run.status, 0);
  assert.ok(run.modules.length <= CEILINGS.statusline, `relo statusline loaded ${run.modules.length} modules (budget ${CEILINGS.statusline}):\n${run.modules.join("\n")}`);
  for (const module of run.modules) for (const pattern of HOOK_NEVER) assert.doesNotMatch(module, pattern, `relo statusline loaded ${module}`);
});

// A wall-clock budget, not logic: scripts/gates.sh runs this test alone (the parallel gates are not running then)
// and the module budgets above still guard what a hook loads. It never skips for load: a busy machine shows up as
// a slow median, so it takes up to three medians and passes on the first one within budget (a real regression is
// over budget in all three).
// scripts/gates.sh runs the CLI suite beside other gates with this set, then runs this test alone afterwards.
const deferred = process.env.RELO_GATES_DEFER_TIMING === "1";

test("a hook costs at most 20 ms over a bare node start (median of 9)", {
  skip: NO_COUNTER || (deferred && "deferred: scripts/gates.sh runs this test alone after the parallel gates"),
}, () => {
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const costs = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const baseline = median(Array.from({ length: 9 }, () => {
      const started = performance.now();
      spawnSync(process.execPath, ["-e", "0"]);
      return performance.now() - started;
    }));
    const hook = median(Array.from({ length: 9 }, () => spawn(["hook", "tool-start", "--agent", "claude-code"], HOOK_INPUT).elapsed));
    costs.push({ hook, baseline });
    if (hook - baseline <= 20) return;
  }
  assert.fail(`relo hook over budget in all ${costs.length} medians: ${costs.map((c) => `${c.hook.toFixed(1)} ms vs node ${c.baseline.toFixed(1)} ms`).join("; ")}`);
});

test("relo --version loads no more modules than its budget", { skip: NO_COUNTER }, () => {
  const run = spawn(["--version"]);
  assert.equal(run.status, 0);
  assert.ok(run.modules.length <= CEILINGS.version, `relo --version loaded ${run.modules.length} modules (budget ${CEILINGS.version})`);
});
