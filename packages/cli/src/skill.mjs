// `relo skill`: puts the relo-notifications skill that ships inside this CLI into ONE harness's skills
// directory, so the skill and the CLI cannot drift apart. Nothing here runs unless the owner (or an agent
// they asked) runs `relo skill install|remove`; `relo doctor` and `relo setup` only read.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "./errors.mjs";
import { expandPath, shortPath } from "./setup.mjs";

export const SKILL_NAME = "relo-notifications";
const EXCLUDED = new Set(["node_modules", "tests", "validate-skill.mjs", ".DS_Store", ".git"]);

const configured = (env, name, fallback) => (env[name]?.trim() ? resolve(env[name].trim()) : fallback);

/**
 * Where each harness reads user-level skills. Global paths follow the `skills` CLI's agent table
 * (github.com/vercel-labs/skills README, "Supported agents"): Claude Code ~/.claude/skills (honouring
 * CLAUDE_CONFIG_DIR), Codex ~/.agents/skills, OpenCode ~/.config/opencode/skills, Gemini CLI ~/.gemini/skills,
 * Amp ~/.config/agents/skills, Cursor ~/.cursor/skills, GitHub Copilot ~/.copilot/skills (honouring COPILOT_HOME).
 * `agents` is the shared ~/.agents/skills directory that Codex, Cline, Warp, Zed, Pi and other "universal"
 * harnesses read. Some harnesses also read other roots (OpenCode and Gemini CLI read ~/.agents/skills too, OpenCode
 * ~/.claude/skills); install into the ONE directory named for the harness so it never finds two copies.
 * Anything else: `--dir PATH`.
 */
export const SKILL_AGENTS = {
  "claude-code": { aliases: ["claude"], root: ({ env, home }) => join(configured(env, "CLAUDE_CONFIG_DIR", join(home, ".claude")), "skills"), config: ".claude" },
  codex: { aliases: [], root: ({ home }) => join(home, ".agents", "skills"), config: ".codex" },
  opencode: { aliases: [], root: ({ home }) => join(home, ".config", "opencode", "skills"), config: ".config/opencode" },
  gemini: { aliases: ["gemini-cli"], root: ({ home }) => join(home, ".gemini", "skills"), config: ".gemini" },
  amp: { aliases: [], root: ({ home }) => join(home, ".config", "agents", "skills"), config: ".config/amp" },
  cursor: { aliases: [], root: ({ home }) => join(home, ".cursor", "skills"), config: ".cursor" },
  copilot: { aliases: ["github-copilot", "copilot-cli"], root: ({ env, home }) => join(configured(env, "COPILOT_HOME", join(home, ".copilot")), "skills"), config: ".copilot" },
  agents: { aliases: ["universal"], root: ({ home }) => join(home, ".agents", "skills") },
};
export const SKILL_AGENT_NAMES = Object.keys(SKILL_AGENTS);
const AGENT_CHOICES = SKILL_AGENT_NAMES.join("|");

function agentRoot(agent, probe) {
  const wanted = String(agent).trim().toLowerCase();
  const name = SKILL_AGENT_NAMES.find((key) => key === wanted || SKILL_AGENTS[key].aliases.includes(wanted));
  return name === undefined ? undefined : { agent: name, root: SKILL_AGENTS[name].root(probe) };
}

/** The skills directory the owner chose: `--agent NAME` or `--dir PATH` (exactly one). */
export function chooseSkillRoot(options, { env, home, cwd }) {
  const dir = options.dir;
  if (options.agent !== undefined && dir !== undefined) throw new UsageError("Pick one of --agent NAME or --dir PATH.");
  if (options.agent === undefined && dir === undefined) {
    throw new UsageError("Pick the one harness whose skills directory to use.", { hint: `relo skill <install|remove> --agent <${AGENT_CHOICES}>, or --dir PATH` });
  }
  if (dir !== undefined) return { root: expandPath(dir, home, cwd) };
  const found = agentRoot(options.agent, { env, home });
  if (!found) {
    throw new UsageError(`Unknown agent "${options.agent}": no skills directory is known for it.`, {
      hint: `Supported: ${SKILL_AGENT_NAMES.join(", ")}. For another harness: --dir PATH (its skills directory)`,
    });
  }
  return found;
}

const isDirectory = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const isBundle = (path) => existsSync(join(path, "SKILL.md")) && existsSync(join(path, "package.json"));

/** The skill this CLI carries: the bundle in the package, else (a git checkout) skills/relo-notifications. */
export function bundledSkillDirectory() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const candidate of [join(packageRoot, "skill"), join(packageRoot, "..", "..", "skills", SKILL_NAME)]) {
    if (isBundle(candidate)) return candidate;
  }
  return undefined;
}

const versionOf = (directory) => {
  try { return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version; } catch { return undefined; }
};

function listFiles(directory, prefix = "") {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(path, `${prefix}${entry.name}/`));
    else if (entry.isFile()) found.push({ name: `${prefix}${entry.name}`, path });
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** One hash over the file names and bytes of a skill folder (node_modules and tests never count). */
export function skillDigest(directory) {
  const hash = createHash("sha256");
  for (const file of listFiles(directory)) {
    hash.update(file.name).update("\0").update(readFileSync(file.path)).update("\0");
  }
  return hash.digest("hex");
}

const stamp = (milliseconds) => new Date(milliseconds).toISOString().replace(/\.\d+Z$/u, "Z").replace(/[-:]/gu, "");

/** Archives live outside every skill discovery root, so an old copy can never shadow the active one. */
export const archiveRoot = (home) => join(home, ".local", "share", "relo", "skill-archives");

function archivePathFor({ home, now, version, root }) {
  const base = join(archiveRoot(home), `${stamp(now)}-${version ?? "unknown"}`);
  let candidate = base;
  for (let n = 2; existsSync(candidate); n += 1) candidate = `${base}-${n}`;
  const inside = (outer, inner) => { const r = relative(outer, inner); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
  if (inside(root, candidate) || inside(candidate, root)) {
    throw new UsageError("That skills directory overlaps Relo's archive folder.", { hint: "Pick a skills directory outside ~/.local/share/relo/skill-archives." });
  }
  return candidate;
}

async function moveAside(source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await rename(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await cp(source, destination, { recursive: true });
    await rm(source, { recursive: true, force: true });
  }
}

async function existingCopy(target) {
  let info;
  try { info = await lstat(target); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new UsageError(`${basename(target)} is a link or a file, not a Relo skill folder.`, { hint: "Remove it by hand; Relo does not follow links." });
  }
  return { version: versionOf(target) };
}

/** Installs (or updates) the bundled skill into `<root>/relo-notifications`. */
export async function installSkill({ root, agent, dryRun, home, now }) {
  const source = bundledSkillDirectory();
  if (source === undefined) {
    throw new UsageError("This Relo install carries no skill bundle.", { hint: "Reinstall the CLI from a release or checkout, or: npx skills add redpanda77/relo@relo-notifications" });
  }
  const version = versionOf(source);
  const target = join(root, SKILL_NAME);
  const shown = shortPath(target, home);
  const base = { agent, dir: shown, version };
  const current = await existingCopy(target);
  if (current && isBundle(target) && skillDigest(target) === skillDigest(source)) return { ...base, action: "unchanged" };
  const archived = current ? archivePathFor({ home, now, version: current.version, root }) : undefined;
  const action = current ? "updated" : "installed";
  const report = { ...base, action, ...(archived ? { archived: shortPath(archived, home) } : {}), ...(dryRun ? { dryRun: true } : {}) };
  if (dryRun) return report;
  await mkdir(root, { recursive: true });
  const staging = join(root, `.${SKILL_NAME}.tmp-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  try {
    await cp(source, staging, { recursive: true, filter: (path) => !EXCLUDED.has(basename(path)) });
    if (current) await moveAside(target, join(archived, SKILL_NAME));
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return report;
}

/** Archives and removes the skill copy under `<root>`. */
export async function removeSkill({ root, agent, dryRun, home, now }) {
  const target = join(root, SKILL_NAME);
  const base = { agent, dir: shortPath(target, home) };
  const current = await existingCopy(target);
  if (!current) return { ...base, action: "absent" };
  const archived = archivePathFor({ home, now, version: current.version, root });
  if (!dryRun) await moveAside(target, join(archived, SKILL_NAME));
  return { ...base, action: "removed", archived: shortPath(archived, home), ...(dryRun ? { dryRun: true } : {}) };
}

/** Every directory a skill copy is looked for: each harness's own, plus Codex's older ~/.codex/skills. */
function discoveryRoots({ env, home }) {
  const roots = new Map();
  for (const name of SKILL_AGENT_NAMES) {
    const root = SKILL_AGENTS[name].root({ env, home });
    if (!roots.has(root)) roots.set(root, name);
  }
  const legacy = join(configured(env, "CODEX_HOME", join(home, ".codex")), "skills");
  if (!roots.has(legacy)) roots.set(legacy, undefined);
  return roots;
}

/** Installed copies of the skill and their versions. Reads only. */
export function findSkillCopies({ env, home, cliVersion }) {
  const copies = [];
  for (const [root, agent] of discoveryRoots({ env, home })) {
    const directory = join(root, SKILL_NAME);
    let present = false;
    try { present = lstatSync(directory).isDirectory() && (existsSync(join(directory, "SKILL.md")) || versionOf(directory) !== undefined); } catch { /* absent */ }
    if (!present) continue;
    const version = versionOf(directory);
    copies.push({ directory, root, agent, version, current: version === cliVersion });
  }
  return copies;
}

/** The installed relo-notifications skill copies and whether they match this CLI. Reads only. */
export function inspectSkill({ env, home, cliVersion }) {
  const copies = findSkillCopies({ env, home, cliVersion });
  const versions = copies.map((copy) => copy.version).filter((version) => version !== undefined);
  const lowest = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  return {
    installed: copies.map((copy) => shortPath(copy.directory, home)),
    ...(lowest === undefined ? {} : { version: lowest }),
    matchesCli: copies.length > 0 && copies.every((copy) => copy.current),
  };
}

/** The harness we are running in (from its environment), else the first one with a config folder, else Claude Code. */
function likelyAgent({ env, home }) {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT?.trim() || env.CLAUDE_CODE_SESSION_ID?.trim()) return "claude-code";
  if (env.CODEX_THREAD_ID?.trim() || env.CODEX_CI?.trim()) return "codex";
  if (env.OPENCODE === "1") return "opencode";
  if (env.GEMINI_CLI === "1") return "gemini";
  if (env.CURSOR_AGENT?.trim()) return "cursor";
  const configs = { "claude-code": configured(env, "CLAUDE_CONFIG_DIR", join(home, ".claude")) };
  return SKILL_AGENT_NAMES.find((name) => SKILL_AGENTS[name].config
    && isDirectory(configs[name] ?? join(home, SKILL_AGENTS[name].config))) ?? "claude-code";
}

const installCommand = (copy, home) => (copy.agent ? `relo skill install --agent ${copy.agent}` : `relo skill install --dir ${shortPath(copy.root, home)}`);

/** What the owner can do about the skill: { state, run?, hint? }. Never installs anything. */
export function skillAdvice({ env, home, cliVersion }) {
  const copies = findSkillCopies({ env, home, cliVersion });
  if (copies.length === 0) {
    const run = `relo skill install --agent ${likelyAgent({ env, home })}`;
    return { state: "missing", run, hint: `The relo-notifications skill is not installed. Install it: ${run}` };
  }
  const stale = copies.filter((copy) => !copy.current);
  if (stale.length === 0) return { state: "current" };
  const run = installCommand(stale[0], home);
  return { state: "outdated", run, hint: `The skill is ${stale[0].version ?? "of unknown version"}, the CLI is ${cliVersion}. Update it: ${run}` };
}

export function skillStatus({ env, home, cliVersion }) {
  return findSkillCopies({ env, home, cliVersion }).map((copy) => ({
    dir: shortPath(copy.directory, home), ...(copy.agent ? { agent: copy.agent } : {}),
    version: copy.version ?? null, current: copy.current,
  }));
}
