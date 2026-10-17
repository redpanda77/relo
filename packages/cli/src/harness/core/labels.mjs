// The labels an observed snapshot carries (project, computer, account), computed locally. Once this
// computer seals for a phone they go out as opaque handles (E2.5) and the names behind them travel only
// sealed, at send time (see observed.mjs). No network here: a hook never waits on it.
import { cleanLabel as label } from "../../shared/label.mjs";
import { resolveComputerName } from "../../shared/computer.mjs";

/** The detected name is stored once so later hooks skip the probe; best effort: a hook never fails over it. */
async function rememberComputer(detected, config, dependencies) {
  if (!detected || !config || config.source === "environment") return;
  try {
    const path = dependencies.configPath();
    const stored = await dependencies.loadStoredConfig(path);
    await dependencies.writeConfig(path, { ...stored, computerName: detected }, { expectedRevision: stored.revision });
  } catch { /* ignore */ }
}

async function computerFor(dependencies, config) {
  let detected;
  const computer = resolveComputerName(dependencies.env, {
    cached: () => config?.computerName ?? dependencies.loadComputerName?.(),
    detect: () => (detected = dependencies.computerName?.()),
  });
  if (detected) await rememberComputer(label(detected, 120), config, dependencies);
  return computer;
}

/**
 * { labels: {project?, computer?, account?}, names: {handle: name} }. `harnessEnv` is the adapter's
 * environment view (so the account resolves like the agent's own relo commands do). On any failure the
 * labels are dropped rather than sent readable.
 */
export async function observedLabels({ cwd, harnessEnv, config, dependencies }) {
  // Loaded only when a snapshot is due (most hook events send nothing), so the hook's startup stays small.
  const { detectAccount, integrationProject, projectLabel } = await import("../../shared/identity.mjs");
  // The same project rule as a card's (shared/identity.mjs), so a session row and its card agree.
  const project = projectLabel(dependencies.env, cwd ?? undefined) ?? label(integrationProject(config, dependencies), 120);
  const plain = {
    project,
    computer: await computerFor(dependencies, config),
    account: label(detectAccount(harnessEnv, dependencies.accountProbes).account, 40),
  };
  try {
    // Loaded only when a snapshot is due: most hook events change no phase and send nothing.
    const { hookLabelsWithNames } = await import("../../crypto/opaque-names.mjs");
    return await hookLabelsWithNames(plain, config?.apiUrl, dependencies);
  } catch {
    return { labels: {}, names: {} };
  }
}

/** THE way to name a session: the adapter's resolveTitle (title + what to cache), else its plain sessionTitle. */
export function resolveSessionTitle(adapter, input, context) {
  if (typeof adapter?.resolveTitle === "function") return adapter.resolveTitle(input, context);
  return { title: adapter?.sessionTitle?.(input, context), cache: {} };
}
