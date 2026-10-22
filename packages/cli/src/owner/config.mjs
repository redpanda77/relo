// `relo config`: this computer's settings, each with its effective value and where it comes from. Read-only,
// local, and the one place the inputs of the registry (shared/settings.mjs) are gathered; the machine report
// (owner/machine-report.mjs) reads the same rows, so the terminal and the Dashboard agree.
import { detectHarness } from "../harness/catalog.mjs";
import { UsageError } from "../shared/errors.mjs";
import { detectAccount } from "../shared/identity.mjs";
import { result } from "../shared/outcome.mjs";
import { folderName, namedPlace } from "../shared/repo.mjs";
import { resolveSettings } from "../shared/settings.mjs";
import { stateRoot } from "../work/state-file.mjs";

const USAGE = "Usage: relo config";

/** Runs a probe that may fail or find nothing: undefined then. */
function tried(probe) {
  try { return probe() ?? undefined; } catch { return undefined; }
}

/**
 * What the registry resolves against on this computer: the variables, the config file's own values, what the
 * machine shows (its name, the git repository around the working folder, the detected harness) and the defaults.
 * Reads only Relo's config and the folder names the identity rules already read.
 */
export async function settingInputs(dependencies) {
  const { env = {}, home, cwd } = dependencies;
  let stored;
  try { stored = await dependencies.loadStoredConfig(dependencies.configPath()); } catch { stored = undefined; }
  const account = tried(() => detectAccount(env, dependencies.accountProbes));
  const config = {
    ...(stored?.apiUrl ? { server: stored.apiUrl } : {}),
    ...(stored?.activeProfile ? { profile: stored.activeProfile } : {}),
    ...(stored?.computerName ? { computer: stored.computerName } : {}),
    ...(account?.via === "nickname" && account.account ? { account: account.account } : {}),
  };
  const place = tried(() => namedPlace(cwd, { names: dependencies.loadProjects?.() ?? {} }));
  if (place?.via === "config") config.project = place.name;
  const detected = {
    ...(account?.via === "directory" && account.account ? { account: account.account } : {}),
    ...Object.fromEntries(Object.entries({
      computer: tried(() => dependencies.computerName?.()),
      project: place?.via === "git" ? place.name : tried(() => folderName(cwd, home)),
      source: tried(() => detectHarness(env)?.label),
    }).filter(([, value]) => value !== undefined)),
  };
  const defaults = {
    profile: "default",
    stateDir: tried(() => stateRoot(env, home)),
    configPath: tried(() => dependencies.configPath()),
  };
  return { env, config, detected, defaults };
}

/** The settings, resolved. Rows carry full values: callers that send them off the machine strip names and paths. */
export async function currentSettings(dependencies) {
  return resolveSettings(await settingInputs(dependencies));
}

const FROM = {
  env: (row) => `${row.env} (environment)`,
  config: () => "config file",
  detected: () => "detected",
  default: () => "default",
};

/** The terminal view: Setting, Value, From. A setting nothing sets shows a dash. */
export function settingsTable(rows) {
  const lines = [["Setting", "Value", "From"], ...rows.map((row) => [row.key, row.value ?? "-", FROM[row.source](row)])];
  const widths = [0, 1, 2].map((column) => Math.max(...lines.map((line) => line[column].length)));
  return lines.map((line) => line.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n");
}

/** `relo config`. */
export async function runConfigCommand({ action, rest, dependencies }) {
  if (action !== undefined || rest.length > 0) throw new UsageError(USAGE);
  const settings = await currentSettings(dependencies);
  return { ...result("config", { settings }), text: settingsTable(settings) };
}
