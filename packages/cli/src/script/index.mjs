// The script and app module (plan 04 §0.1, §2.9). Nothing here imports from agent/; shared primitives come from work/.
import { assertAllowedOptions, getAuthenticated } from "../support.mjs";
import { runScriptWork, SCRIPT_ALLOWED } from "./work.mjs";

export { waitForAnswer, waitPlan, exitCodeFor } from "./ask.mjs";

export async function runScriptCommand(command) {
  if (command.group === "activity") return undefined;
  assertAllowedOptions(command.options, command.group === "state" || command.action === "state" ? ["producer", "sync", "work"] : SCRIPT_ALLOWED[command.action] ?? []);
  if (!command.options["dry-run"]) Object.assign(command, await getAuthenticated(command.dependencies));
  return runScriptWork(command);
}
