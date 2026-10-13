import { UsageError } from "../errors.mjs";
import { assertAllowedOptions, assertNoExtra, result } from "../support.mjs";
import { runUpdate } from "../update.mjs";

const USAGE = "Usage: relo update [--check] [--rollback] [--version X] [--dry-run]";

/** `relo update`: the owner's command to move this CLI to the latest GitHub release (or back). Never automatic. */
export async function runUpdateCommand(command) {
  const { options, group, action, rest, dependencies } = command;
  if (group !== "update") return undefined;
  if (action !== undefined) throw new UsageError(USAGE);
  assertNoExtra(rest, 0, USAGE);
  assertAllowedOptions(options, ["check", "rollback", "version", "dry-run"]);
  const { data, notes } = await runUpdate(options, dependencies);
  return result("update", data, { notes });
}
