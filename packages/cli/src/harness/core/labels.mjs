// The labels an observed snapshot carries (project, computer, account), computed locally. Once this
// computer seals for a phone they go out as opaque handles (E2.5) and the names behind them travel only
// sealed, at send time (see observed.mjs). No network here: a hook never waits on it.
import { detectAccount, repositoryName } from "../../identity.mjs";
import { hookLabelsWithNames } from "../../opaque-names.mjs";

export const label = (value, maximum) => {
  const text = Array.from(String(value ?? "").replace(/[\u0000-\u001F\u007F]/gu, " ").trim()).slice(0, maximum).join("").trim();
  return text || undefined;
};

async function computerFor(dependencies, config) {
  const fromEnv = label(dependencies.env.RELO_COMPUTER, 120);
  if (fromEnv) return fromEnv;
  const cached = label(config?.computerName ?? dependencies.loadComputerName?.(), 120);
  if (cached) return cached;
  const detected = label(dependencies.computerName?.(), 120);
  // Cached once so later hooks skip the probe. Best effort: a hook never fails over it.
  if (detected && config && config.source !== "environment") {
    try {
      const path = dependencies.configPath();
      const stored = await dependencies.loadStoredConfig(path);
      await dependencies.writeConfig(path, { ...stored, computerName: detected }, { expectedRevision: stored.revision });
    } catch { /* ignore */ }
  }
  return detected;
}

/**
 * { labels: {project?, computer?, account?}, names: {handle: name} }. `harnessEnv` is the adapter's
 * environment view (so the account resolves like the agent's own relo commands do). On any failure the
 * labels are dropped rather than sent readable.
 */
export async function observedLabels({ cwd, harnessEnv, config, dependencies }) {
  let project = label(dependencies.env.RELO_PROJECT, 120);
  if (!project && cwd) {
    try { project = label(repositoryName(cwd), 120); } catch { /* no repository */ }
  }
  const plain = {
    project,
    computer: await computerFor(dependencies, config),
    account: label(detectAccount(harnessEnv, dependencies.accountProbes).account, 40),
  };
  try {
    return await hookLabelsWithNames(plain, config?.apiUrl, dependencies);
  } catch {
    return { labels: {}, names: {} };
  }
}
