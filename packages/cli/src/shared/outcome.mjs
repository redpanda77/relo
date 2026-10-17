// A command's outcome: what the CLI renders and the exit code it ends with.
import { EXIT } from "./errors.mjs";

export function result(command, data, { message, notes } = {}) {
  return { exitCode: EXIT.OK, command, data, message, ...(notes?.length ? { notes } : {}) };
}

/** `--dry-run` outcome: what would be sent, validated locally, with no request made. */
export function dryRunResult(command, body, notes) {
  return result("dry-run", { dryRun: true, would: { command, body } }, { notes });
}
