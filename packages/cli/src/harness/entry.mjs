// `relo hook <event|role> [--agent NAME]`: the one entry point for agent-harness hooks (installed by
// `relo setup --level guide`). Argument parsing and dispatch only:
//  - observed events (start, prompt, tool-start, tool-end, wait, stop, end, subagent-start,
//    subagent-stop, compact) feed the local session state machine (harness/core/process.mjs), which
//    queues a phase snapshot only on a transition and returns without waiting on the network;
//  - local roles (remind, restore, turn, …) run harness/core/roles.mjs and may print ONE object.
// Hooks write observed state only: they never create, change or end work, cards or questions. The
// adapter reads only the native fields it maps; prompts, tool input/output and transcript paths are
// dropped unread. Nothing else is printed, and the caller exits 0 whatever happens.
import { loadAdapter } from "./adapters/load.mjs";
import { EVENT_COMMANDS } from "./core/events.mjs";
import { processHook } from "./core/process.mjs";
import { HARNESS_ROLES, runHarnessRole } from "./core/roles.mjs";
import { hookDependencies } from "../hook-deps.mjs";

const STDIN_TIMEOUT_MS = 1_500;

async function readInput(dependencies) {
  if (dependencies.stdinIsTTY) return {};
  const timer = {};
  const timeout = new Promise((resolve) => { timer.id = setTimeout(() => resolve({}), STDIN_TIMEOUT_MS); timer.id.unref?.(); });
  try {
    const value = await Promise.race([dependencies.readStdinJson(), timeout]);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  } finally {
    clearTimeout(timer.id);
  }
}

/**
 * `hook [NAME] [--agent ID]` (or `--agent=ID`); undefined for anything else, which a hook ignores. Without
 * NAME the adapter maps the native event named on stdin.
 */
function hookArguments(argv) {
  if (argv[0] !== "hook") return undefined;
  const rest = argv.slice(1);
  const name = rest[0] !== undefined && !rest[0].startsWith("--") ? rest.shift() : undefined;
  if (rest.length === 0) return { name };
  if (rest.length === 1 && rest[0].startsWith("--agent=")) return { name, agent: rest[0].slice("--agent=".length) };
  if (rest.length === 2 && rest[0] === "--agent") return { name, agent: rest[1] };
  return undefined;
}

/** One hook event or role. Silent by design: the result is for tests; the process prints nothing else. */
async function runHookEvent({ name, agent, dependencies }) {
  const adapter = await loadAdapter(agent);
  if (!adapter) return { queued: false, reason: "unknown_harness" };
  const input = await readInput(dependencies);
  if (HARNESS_ROLES.includes(name)) return runHarnessRole({ adapter, role: name, input, dependencies });
  return processHook({ adapter, named: EVENT_COMMANDS[name], input, dependencies });
}

/**
 * `relo hook …`, straight from bin/relo.mjs: its own tiny parse and the shared dependencies, never the
 * command dispatcher. Always exit 0: a hook never fails the agent.
 */
export async function runHook(argv, overrides = {}) {
  try {
    const parsed = hookArguments(argv);
    if (parsed) await runHookEvent({ ...parsed, dependencies: hookDependencies(overrides) });
  } catch { /* a hook never fails the agent */ }
  return 0;
}

const STATUSLINE_STDIN_TIMEOUT_MS = 1_500;

/** The status line JSON as the bytes Claude Code wrote (the previous command gets them untouched). */
async function readRawStdin(overrides) {
  if (overrides.readStdinRaw) return overrides.readStdinRaw();
  const stream = overrides.stdinStream ?? process.stdin;
  if (stream.isTTY) return Buffer.alloc(0);
  const chunks = [];
  const reading = (async () => { for await (const chunk of stream) chunks.push(Buffer.from(chunk)); })().catch(() => {});
  let timer;
  await Promise.race([reading, new Promise((resolve) => { timer = setTimeout(resolve, STATUSLINE_STDIN_TIMEOUT_MS); timer.unref?.(); })]);
  clearTimeout(timer);
  return Buffer.concat(chunks);
}

/**
 * `relo statusline`, straight from bin/relo.mjs: Claude Code's status line wrapper (harness/core/statusline.mjs). It
 * prints the owner's previous status line unchanged and always exits 0.
 */
export async function runStatusline(overrides = {}) {
  try {
    const dependencies = hookDependencies(overrides);
    const { runStatusline: run } = await import("./core/statusline.mjs");
    await run({ adapter: await loadAdapter("claude-code"), raw: await readRawStdin(overrides), dependencies, write: overrides.write ?? ((bytes) => process.stdout.write(bytes)) });
  } catch { /* the status line is never failed by Relo */ }
  return 0;
}

/**
 * The Relo MCP server's leave (composition root: cli.mjs, after it confirmed the harness process `pid` is gone): ends every
 * observed session that harness ran, reason "mcp", and starts the flusher. Observed state only. Resolves with the ended
 * sessions [{ session, harness }]; never rejects.
 */
export async function endProcessSessions({ pid }, overrides = {}) {
  try {
    const { endSessionsOfProcess } = await import("./core/sweep.mjs");
    const { adapterFor } = await import("./adapters/index.mjs");
    return await endSessionsOfProcess({ pid, dependencies: hookDependencies(overrides), adapterFor });
  } catch { return []; }
}

/** One throttled liveness sweep for a caller that is not the flusher (the Relo MCP server's minute tick); it starts a flusher when it ends a session. */
export async function sweepSessions(overrides = {}, records) {
  try {
    const { sweepGoneSessions } = await import("./core/sweep.mjs");
    const { adapterFor } = await import("./adapters/index.mjs");
    return await sweepGoneSessions({ dependencies: hookDependencies(overrides), adapterFor, startFlusher: true, records });
  } catch { return []; }
}

/** The Relo MCP server's minute tick: one heartbeat snapshot per session of its harness (process `pid`) at a permission prompt. Never rejects. */
export async function heartbeatSessions({ pid }, overrides = {}, records) {
  try {
    const { heartbeatSessionsOfProcess } = await import("./core/sweep.mjs");
    const { adapterFor } = await import("./adapters/index.mjs");
    return await heartbeatSessionsOfProcess({ pid, dependencies: hookDependencies(overrides), adapterFor, records });
  } catch { return []; }
}

/** The observed folder's records, listed once for a tick's sweep and heartbeat. Never rejects; [] when unreadable. */
export async function listSessionRecords(overrides = {}) {
  try {
    const { readRecords } = await import("./core/sweep.mjs");
    return await readRecords(hookDependencies(overrides).observedStateDirectory);
  } catch { return []; }
}
