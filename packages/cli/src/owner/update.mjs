import { ReloError, UsageError } from "../shared/errors.mjs";
import { assertNoExtra } from "../shared/validate.mjs";
import { result } from "../shared/outcome.mjs";
import { runUpdate } from "./releases.mjs";

const USAGE = "Usage: relo update [--check] [--rollback] [--version X] [--dry-run]";

/** `relo update`: move this CLI to the newest release (or back). `--auto` is the background run auto-update.mjs starts. */
export async function runUpdateCommand(command) {
  const { options, group, action, rest, dependencies } = command;
  if (group !== "update") return undefined;
  if (action !== undefined) throw new UsageError(USAGE);
  assertNoExtra(rest, 0, USAGE);
  // Anything that installs holds the one update lock: a background run and a person's run never overlap.
  const installs = !options.check && !options["dry-run"];
  const { acquireUpdateLock, recordAutoUpdate } = installs ? await import("./auto-update.mjs") : {};
  const release = installs ? acquireUpdateLock(dependencies.home) : () => {};
  if (!release) {
    if (options.auto) return result("update", { ok: true, skipped: "another update is running" });
    throw new ReloError("Another relo update is running on this computer.", { code: "UPDATE_RUNNING", details: { hint: "Wait a minute, then: relo --version" } });
  }
  try {
    const { data, notes } = await runUpdate(options.auto ? {} : options, dependencies);
    if (options.auto) recordAutoUpdate(dependencies.home, { ok: true, to: data.to ?? data.current });
    return result("update", data, { notes });
  } catch (error) {
    if (options.auto) recordAutoUpdate(dependencies.home, { ok: false, error: String(error?.code ?? error?.message ?? error).slice(0, 200) });
    throw error;
  } finally {
    release();
  }
}
