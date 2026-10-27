import { ReloError, UsageError } from "../shared/errors.mjs";
import { assertNoExtra } from "../shared/validate.mjs";
import { result } from "../shared/outcome.mjs";
import { runUpdate } from "./releases.mjs";

const USAGE = "Usage: relo update [--check] [--rollback] [--version X] [--dry-run] [--mode auto|ask|off|managed]";

/** The variables `relo ask` needs to reach the server as this computer, and nothing that names an agent session. */
const ASK_ENV = ["HOME", "PATH", "TMPDIR", "RELO_CONFIG_PATH", "RELO_KEY_STORE_PATH", "RELO_STATE_DIR",
  "RELO_API_URL", "RELO_TOKEN", "RELO_PROFILE", "RELO_COMPUTER"];
const asked = (name) => ASK_ENV.includes(name) || name.startsWith("XDG_");

/**
 * Ask mode: one yes/no question on the owner's phone ("Update the Relo CLI on build-box to 0.17.52?"), asked through
 * this CLI's own `relo ask` with no agent session, so it never lands on a work card. Its idempotency key makes a
 * second updater for the same version wait on the same question. Resolves "approved", "declined" or "unanswered".
 */
export function askToUpdate({ dependencies, target, computer, spawnImpl }) {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(dependencies.env).filter(([name, value]) => asked(name) && value !== undefined));
    const question = `Update the Relo CLI on ${computer} to ${target}?`.slice(0, 120);
    const child = spawnImpl(process.execPath, [dependencies.entrypoint, "ask", question, "--yes-no", "--notification-only", "--source", "Relo",
      "--project", "Relo", "--topic", "Updates", "--expires-in", "8h", "--timeout", "8h",
      "--idempotency-key", `relo-update:${computer}:${target}`.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 120),
      "--detail", "Your Relo server offers a newer CLI. Yes installs it on this computer now (checked against the server's digest; relo update --rollback goes back). No skips this version."],
    { stdio: "ignore", env: { ...env, RELO_SOURCE: "Relo", RELO_UPDATES: "off" }, windowsHide: true });
    child.on("error", () => resolve("unanswered"));
    child.on("exit", (code) => resolve(code === 0 ? "approved" : code === 5 ? "declined" : "unanswered"));
  });
}

/** `relo update`: move this CLI to the newest release (or back). `--auto` is the background run auto-update.mjs starts. */
export async function runUpdateCommand(command) {
  const { options, group, action, rest, dependencies } = command;
  if (group !== "update") return undefined;
  if (action !== undefined) throw new UsageError(USAGE);
  assertNoExtra(rest, 0, USAGE);
  if (options.mode !== undefined) {
    const { UPDATE_MODES, setUpdateMode, updateMode } = await import("./auto-update.mjs");
    if (!UPDATE_MODES.includes(options.mode)) throw new UsageError(USAGE);
    setUpdateMode(dependencies.home, options.mode, dependencies.entrypoint);
    const effective = updateMode({ home: dependencies.home, env: dependencies.env, entrypoint: dependencies.entrypoint });
    return result("update", { ok: true, mode: options.mode, ...(effective !== options.mode ? { effective } : {}) },
      { message: effective !== options.mode ? `Stored ${options.mode}; ${dependencies.env.RELO_UPDATES ? "RELO_UPDATES" : "RELO_NO_UPDATE_CHECK"} keeps it ${effective} for now.` : undefined });
  }
  // Managed: the Relo app keeps this CLI current, so this CLI checks and installs nothing itself.
  const { updateMode: modeOf, bundledEntrypoint } = await import("./auto-update.mjs");
  if (modeOf({ home: dependencies.home, env: dependencies.env, entrypoint: dependencies.entrypoint }) === "managed") {
    return result("update", { ok: true, managed: true, current: dependencies.version }, { message: "The Relo app keeps this CLI up to date; nothing to do here." });
  }
  // The CLI inside the app is never npm-installed over itself, whatever the mode: only a new Relo for Mac replaces it.
  if (bundledEntrypoint(dependencies.entrypoint)) {
    return result("update", { ok: true, managed: true, bundled: true, current: dependencies.version }, { message: "This relo is part of Relo for Mac; update the app to update it." });
  }
  if (options.auto) {
    const { autoUpdateState, recordAutoUpdate, updateMode } = await import("./auto-update.mjs");
    if (updateMode({ home: dependencies.home, env: dependencies.env, entrypoint: dependencies.entrypoint }) === "ask") {
      const target = autoUpdateState(dependencies.home).target;
      if (!target) return result("update", { ok: true, skipped: "nothing to ask about" });
      const { spawn } = await import("node:child_process");
      const computer = dependencies.computerName?.() || "this computer";
      const answer = await askToUpdate({ dependencies, target, computer, spawnImpl: dependencies.spawnAutoUpdate ?? spawn });
      if (answer !== "approved") {
        // Either way this version is left alone: a later one asks again, and `relo update` installs it any time.
        recordAutoUpdate(dependencies.home, answer === "declined" ? { declined: true, asking: false } : { unanswered: true, asking: false });
        return result("update", { ok: true, skipped: answer === "declined" ? "the owner said no" : "no answer" });
      }
      recordAutoUpdate(dependencies.home, { asking: false, approved: true });
    }
  }
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
