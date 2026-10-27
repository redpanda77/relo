import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative } from "node:path";
import { definedFields } from "./validate.mjs";
import { HARNESSES, detectHarness } from "../harness/catalog.mjs";
import { configDirectory } from "../harness/paths.mjs";
import { cleanLabel } from "./label.mjs";
import { folderName, namedPlace } from "./repo.mjs";
import { detectComputerName, resolveComputerName } from "./computer.mjs";
import { envSetting } from "./settings.mjs";


/**
 * Where a nickname for the calling agent's account is keyed: the harness's config folder when the
 * environment can move it (CLAUDE_CONFIG_DIR, CODEX_HOME), else the harness name.
 */
function agentConfigDirectory(harness, env, home) {
  if (harness?.config?.variable) {
    const { directory, custom } = configDirectory(harness, { env, home });
    return { directory, key: directory, custom, standard: basename(harness.config.home).replace(/^\./u, "") };
  }
  const name = harness?.label ?? envSetting("source", env);
  return name === undefined ? undefined : { directory: undefined, key: `harness:${name.toLowerCase().slice(0, 80)}`, custom: false };
}

/** A nickname from a custom config folder's name: ~/.claude-work becomes "work". */
function accountFromDirectory(directory, standard) {
  const prefix = new RegExp(`^${standard}[-_]`, "iu");
  const name = basename(directory).replace(/^\./u, "").replace(prefix, "");
  return name && name.toLowerCase() !== standard.toLowerCase() ? cleanLabel(name, 40) : undefined;
}

/**
 * Which agent account is this? RELO_ACCOUNT, else a nickname from `relo account NAME`, else the name
 * of a custom CLAUDE_CONFIG_DIR / CODEX_HOME. Only directory names and Relo's own config are read.
 */
export function detectAccount(env = process.env, probes = {}) {
  const harness = detectHarness(env);
  const agent = harness?.label;
  const where = agentConfigDirectory(harness, env, probes.home ?? homedir());
  const configDirectory = where?.directory;
  const accountKey = where?.key;
  const fromEnv = cleanLabel(envSetting("account", env), 40);
  if (fromEnv) return { account: fromEnv, via: "RELO_ACCOUNT", agent, configDirectory, accountKey };
  if (where === undefined) return { account: undefined, agent, configDirectory, accountKey };
  const stored = cleanLabel((probes.accounts?.() ?? {})[where.key], 40);
  if (stored) return { account: stored, via: "nickname", agent, configDirectory, accountKey };
  const derived = where.custom ? accountFromDirectory(where.directory, where.standard) : undefined;
  return { account: derived, ...(derived ? { via: "directory" } : {}), agent, configDirectory, accountKey };
}

/**
 * Identity an agent should not have to repeat: RELO_SOURCE/RELO_PROJECT/RELO_TOPIC, then the
 * calling agent recognized from its environment and the place it runs in (projectLabel). The topic is
 * never guessed: only the caller knows what the work is about. `projects`: the saved folder names.
 */
export function detectIdentityDefaults(env = process.env, cwd = process.cwd(), exists = existsSync, projects = {}) {
  return definedFields({
    providerName: envSetting("source", env) ?? detectHarness(env)?.label,
    project: projectLabel(env, cwd, exists, projects),
    threadName: envSetting("topic", env),
  });
}

/**
 * The project of work and of its session: RELO_PROJECT, else the nearest of a folder named with `relo project
 * NAME` and the git repository around `cwd`. The one rule both the declared lane (cards) and the hook lane
 * (session rows) use, cleaned the way the server stores it. Undefined when neither names the place: the caller
 * then tries the signed-in integration and last the folder's own name (fallbackProject).
 */
export function projectLabel(env = process.env, cwd = process.cwd(), exists = existsSync, projects = {}) {
  const fromEnv = cleanLabel(envSetting("project", env), 120);
  if (fromEnv) return fromEnv;
  try { return cleanLabel(namedPlace(cwd, { exists, names: projects })?.name, 120); } catch { return undefined; }
}

/**
 * The project when nothing names the place: the signed-in integration's name (integrationProject), else the
 * working folder's own name. Never a made-up or product name: a card from ~/Documents/GitHub reads "GitHub".
 * A harness's own config folder is no project (Antigravity starts MCP servers in ~/.gemini/config).
 */
export function fallbackProject(config, dependencies) {
  const integration = integrationProject(config, dependencies);
  if (integration) return cleanLabel(integration, 120);
  const cwd = dependencies.cwd ?? process.cwd();
  if (inHarnessConfig(cwd, dependencies.env ?? process.env, dependencies.home ?? homedir())) return undefined;
  try { return cleanLabel(folderName(cwd, dependencies.home), 120); } catch { return undefined; }
}

/** Whether `cwd` is a harness's config folder or inside one. */
function inHarnessConfig(cwd, env, home) {
  return HARNESSES.some((harness) => {
    const directory = configDirectory(harness, { env, home })?.directory;
    if (directory === undefined) return false;
    const path = relative(directory, cwd);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  });
}

/**
 * The project for work started outside a git repository: a named profile (RELO_PROFILE=deploy-bot),
 * else the login's client name unless that is just this computer's name (the default).
 */
export function integrationProject(config, dependencies) {
  if (config?.profile && config.profile !== "default") return config.profile;
  const name = typeof config?.principal?.name === "string" ? config.principal.name.trim() : "";
  if (!name) return undefined;
  let computer;
  try { computer = dependencies.computerName?.(); } catch { computer = undefined; }
  return name.toLowerCase() === String(computer ?? "").trim().toLowerCase() ? undefined : name;
}

/** Where a card came from: this computer and agent account. Only creations need it. */
export function detectOrigin(env = process.env, probes = {}, cachedComputerName) {
  const computer = resolveComputerName(env, { cached: cachedComputerName, detect: () => detectComputerName(env, probes) });
  return definedFields({ computer, account: detectAccount(env, probes).account });
}
