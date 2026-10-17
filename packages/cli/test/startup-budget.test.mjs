// What a command pays for at startup, measured in a real spawned process (the in-process hook test in
// harness-invariants runs with a warm module cache and cannot see this). A hook runs on every tool call,
// so what it loads is a budget: bin/relo.mjs sends it straight to harness/entry.mjs with the hook
// dependencies only, and sealing, labels and the flusher's child_process load only when used.
import "./hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/relo.mjs", import.meta.url));
const COUNTER = fileURLToPath(new URL("./module-counter.mjs", import.meta.url));

// The hook reads its config, which checks the server address with the shared origin rule (origin.generated.mjs).
// 38: shared/settings.mjs (dependency-free) is the one place a variable is read (RELO_PROFILE, RELO_COMPUTER).
// 40: the OpenCode adapter (its descriptor and module), registered beside Claude Code and Gemini CLI.
// The turn hook adds one module (harness/core/turn.mjs, loaded only for that role) to read the open work.
// The status line wrapper reads a few local files and runs the owner's command (child_process loads only then); the
// snapshot path (process.mjs, the adapters) loads only when a reading moved enough to send.
// 41: the turn hook and the status line reach one more shared module (context size from hooks).
const CEILINGS = { hook: 41, turn: 41, statusline: 41, version: 2 };
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

test("a hook loads no more modules than its budget", () => {
  const run = spawn(["hook", "tool-start", "--agent", "claude-code"], HOOK_INPUT);
  assert.equal(run.status, 0);
  assert.ok(run.modules.length <= CEILINGS.hook, `relo hook loaded ${run.modules.length} modules (budget ${CEILINGS.hook}):\n${run.modules.join("\n")}`);
  for (const module of run.modules) for (const pattern of HOOK_NEVER) assert.doesNotMatch(module, pattern, `relo hook loaded ${module}`);
});

test("the turn hook (UserPromptSubmit context) stays local: one module over a hook, none of the forbidden ones", () => {
  const run = spawn(["hook", "turn", "--agent", "claude-code"], { session_id: HOOK_INPUT.session_id, hook_event_name: "UserPromptSubmit" });
  assert.equal(run.status, 0);
  assert.ok(run.modules.length <= CEILINGS.turn, `relo hook turn loaded ${run.modules.length} modules (budget ${CEILINGS.turn}):\n${run.modules.join("\n")}`);
  for (const module of run.modules) for (const pattern of HOOK_NEVER) assert.doesNotMatch(module, pattern, `relo hook turn loaded ${module}`);
});

test("the status line wrapper stays local: a small module count, none of the forbidden ones", () => {
  const run = spawn(["statusline"], { session_id: HOOK_INPUT.session_id });
  assert.equal(run.status, 0);
  assert.ok(run.modules.length <= CEILINGS.statusline, `relo statusline loaded ${run.modules.length} modules (budget ${CEILINGS.statusline}):\n${run.modules.join("\n")}`);
  for (const module of run.modules) for (const pattern of HOOK_NEVER) assert.doesNotMatch(module, pattern, `relo statusline loaded ${module}`);
});

// Wall-clock time means nothing on a saturated machine (other sessions' builds and test runs): the module
// budget above still guards what a hook loads.
const saturated = loadavg()[0] >= availableParallelism();
// scripts/gates.sh runs the CLI suite beside other gates with this set, then runs this test alone afterwards.
const deferred = process.env.RELO_GATES_DEFER_TIMING === "1";

test("a hook costs at most 20 ms over a bare node start (median of 9)", {
  skip: (deferred && "deferred: scripts/gates.sh runs this test alone after the parallel gates")
    || (saturated && "the machine is saturated (load ≥ cores)"),
}, () => {
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const baseline = median(Array.from({ length: 9 }, () => {
    const started = performance.now();
    spawnSync(process.execPath, ["-e", "0"]);
    return performance.now() - started;
  }));
  const hook = median(Array.from({ length: 9 }, () => spawn(["hook", "tool-start", "--agent", "claude-code"], HOOK_INPUT).elapsed));
  assert.ok(hook - baseline <= 20, `relo hook took ${hook.toFixed(1)} ms, node alone ${baseline.toFixed(1)} ms`);
});

test("relo --version loads no more modules than its budget", () => {
  const run = spawn(["--version"]);
  assert.equal(run.status, 0);
  assert.ok(run.modules.length <= CEILINGS.version, `relo --version loaded ${run.modules.length} modules (budget ${CEILINGS.version})`);
});
