// `relo hook <event|role> [--agent NAME]`: the one entry point for agent-harness hooks (installed by
// `relo setup --hooks`). Argument parsing and dispatch only:
//  - observed events (start, prompt, tool-start, tool-end, wait, stop, end, subagent-start,
//    subagent-stop, compact) feed the local session state machine (harness/core/process.mjs), which
//    queues a phase snapshot only on a transition and returns without waiting on the network;
//  - local roles (remind, restore, turn, …) run harness/core/roles.mjs and may print ONE object.
// Hooks write observed state only: they never create, change or end work, cards or questions. The
// adapter reads only the native fields it maps; prompts, tool input/output and transcript paths are
// dropped unread. Nothing else is printed, and the caller exits 0 whatever happens.
import { adapterFor } from "../harness/adapters/index.mjs";
import { EVENT_COMMANDS } from "../harness/core/events.mjs";
import { processHook } from "../harness/core/process.mjs";
import { HARNESS_ROLES, runHarnessRole } from "../harness/core/roles.mjs";
import { assertAllowedOptions, result } from "../support.mjs";

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

/** `relo hook EVENT [--agent NAME]`: silent by design; the CLI entry point discards the result. */
export async function runHookCommand(command) {
  const { options, group, positionals, dependencies } = command;
  if (group !== "hook") return undefined;
  assertAllowedOptions(options, ["agent"]);
  const adapter = adapterFor(options.agent ?? undefined);
  if (!adapter) return result("hook", { queued: false, reason: "unknown_harness" });
  const name = positionals[1];
  const input = await readInput(dependencies);
  if (HARNESS_ROLES.includes(name)) {
    return result("hook", await runHarnessRole({ adapter, role: name, input, dependencies }));
  }
  return result("hook", await processHook({ adapter, named: EVENT_COMMANDS[name], input, dependencies }));
}
