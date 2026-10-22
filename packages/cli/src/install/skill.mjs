// The relo-notifications skill that ships inside this CLI, copied into a harness's skills folder so the
// skill and the CLI cannot drift apart. relo setup installs it, --refresh updates it, relo uninstall
// archives it; relo doctor only reads.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "../shared/errors.mjs";
import { shortPath } from "./block.mjs";
import { HARNESSES, detectHarness, harnessFor, presentHarnesses } from "../harness/catalog.mjs";
import { harnessPath } from "../harness/paths.mjs";
import { dataRoot } from "../work/state-file.mjs";

const SKILL_NAME = "relo-notifications";
const EXCLUDED = new Set(["node_modules", "tests", "validate-skill.mjs", ".DS_Store", ".git"]);

/** The harnesses with a user-level skills folder (harness/catalog.mjs); install into the ONE named for the harness. */
const SKILL_HARNESSES = HARNESSES.filter((harness) => harness.skills);

function agentRoot(agent, probe) {
  const harness = harnessFor(agent);
  return harness?.skills ? { agent: harness.id, root: harnessPath(harness, harness.skills, probe) } : undefined;
}

const isBundle = (path) => existsSync(join(path, "SKILL.md")) && existsSync(join(path, "package.json"));

/**
 * The skill this CLI carries. In a git checkout, the source (skills/relo-notifications) itself, so an edit is
 * never shadowed by a bundle built before it; in an installed package, the bundle in skill/.
 */
export function bundledSkillDirectory() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (const candidate of [join(packageRoot, "..", "..", "skills", SKILL_NAME), join(packageRoot, "skill")]) {
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
function skillDigest(directory) {
  const hash = createHash("sha256");
  for (const file of listFiles(directory)) {
    hash.update(file.name).update("\0").update(readFileSync(file.path)).update("\0");
  }
  return hash.digest("hex");
}

const stamp = (milliseconds) => new Date(milliseconds).toISOString().replace(/\.\d+Z$/u, "Z").replace(/[-:]/gu, "");

/** Archives live outside every skill discovery root, so an old copy can never shadow the active one. */
const archiveRoot = (home) => join(dataRoot(home), "skill-archives");

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

/** Archived copies kept: enough to recover the last few, never one per update forever (19 Oct: 148 had piled up). */
export const KEPT_ARCHIVES = 4;

async function moveAside(source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await rename(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await cp(source, destination, { recursive: true });
    await rm(source, { recursive: true, force: true });
  }
  // Archive names start with a UTC stamp, so name order is age order.
  const root = dirname(dirname(destination));
  const old = readdirSync(root).filter((name) => /^\d{8}T\d{6}Z-/u.test(name)).sort().slice(0, -KEPT_ARCHIVES);
  await Promise.all(old.map((name) => rm(join(root, name), { recursive: true, force: true })));
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
  for (const harness of SKILL_HARNESSES) {
    const root = harnessPath(harness, harness.skills, { env, home });
    if (!roots.has(root)) roots.set(root, harness.id);
  }
  for (const harness of HARNESSES.filter((candidate) => candidate.legacySkills)) {
    const legacy = harnessPath(harness, harness.legacySkills, { env, home });
    if (!roots.has(legacy)) roots.set(legacy, undefined);
  }
  return roots;
}

/** Installed copies of the skill and their versions. Reads only. */
export function findSkillCopies({ env, home, cliVersion }) {
  // A copy is current when its files match the skill this CLI carries, not merely its version number:
  // an edited or half-copied folder at the right version is stale too.
  const source = bundledSkillDirectory();
  const wanted = source ? skillDigest(source) : undefined;
  const copies = [];
  for (const [root, agent] of discoveryRoots({ env, home })) {
    const directory = join(root, SKILL_NAME);
    let present = false;
    try { present = lstatSync(directory).isDirectory() && (existsSync(join(directory, "SKILL.md")) || versionOf(directory) !== undefined); } catch { /* absent */ }
    if (!present) continue;
    const version = versionOf(directory);
    const current = wanted ? isBundle(directory) && skillDigest(directory) === wanted : version === cliVersion;
    copies.push({ directory, root, agent, version, current });
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
  const running = detectHarness(env) ?? SKILL_HARNESSES.find((harness) => harness.sessionVariable && env[harness.sessionVariable]?.trim());
  if (running?.skills) return running.id;
  return presentHarnesses({ env, home }).find((harness) => harness.skills)?.id ?? "claude-code";
}


/** What the owner can do about the skill: { state, run?, hint? }. Never installs anything. */
export function skillAdvice({ env, home, cliVersion }) {
  const copies = findSkillCopies({ env, home, cliVersion });
  if (copies.length === 0) {
    const run = `relo setup --agent ${likelyAgent({ env, home })}`;
    return { state: "missing", run, hint: `The relo-notifications skill is not installed. Install it: ${run}` };
  }
  const stale = copies.filter((copy) => !copy.current);
  if (stale.length === 0) return { state: "current" };
  const run = "relo setup --refresh";
  return { state: "outdated", run, hint: `The skill is ${stale[0].version ?? "of unknown version"}, the CLI is ${cliVersion}. Update it: ${run}` };
}
