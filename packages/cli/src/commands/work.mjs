// `relo work …` and `relo state`: dispatched per producer type (plan 04 §0.1). The agent module serves
// agent sessions and unidentified callers; scripts get their own module (not built yet).
import { surfaceFor } from "../caller.mjs";
import { runAgentCommand } from "../agent/index.mjs";
import { runScriptCommand } from "../script/index.mjs";
import { WorkRefusal } from "../work/refusal.mjs";
import { assertAllowedOptions, getAuthenticated } from "../support.mjs";
import { ALLOWED } from "../agent/work.mjs";

export const isWorkCommand = ({ group }) => group === "work" || group === "state" || group === "activity";

export async function runWorkCommand(command) {
  const { group, options, dependencies } = command;
  if (!isWorkCommand(command)) return undefined;
  if (surfaceFor(dependencies.caller) === "script" && group !== "activity") return runScriptCommand(command);
  if (surfaceFor(dependencies.caller) === "script") {
    if (group === "activity") return undefined;
    assertAllowedOptions(command.options, group === "state" || command.action === "state" ? ["sync", "work"] : ALLOWED[command.action] ?? []);
    throw new WorkRefusal("NOT_AVAILABLE", { what: "relo work for scripts and apps is not available in this build", state: "this shell is not inside an agent session", next: 'relo activity start --title "…" --status "…"' });
  }
  if (group === "activity") return runAgentCommand(command);
  const dryRun = Boolean(options["dry-run"]) && group === "work";
  if (!dryRun) Object.assign(command, await getAuthenticated(dependencies));
  return runAgentCommand(command);
}
