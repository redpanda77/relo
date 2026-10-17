// `relo setup`: a short, marked instruction block in ONE instruction file the owner chooses, so an
// agent knows Relo exists before the skill triggers. Only text between the markers is ever touched.
// Never automatic: nothing but `relo setup` writes it, and doctor never suggests running it.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { repositoryRoot } from "../shared/repo.mjs";
import { HARNESSES } from "../harness/catalog.mjs";
import { harnessPath } from "../harness/paths.mjs";
import { UsageError } from "../shared/errors.mjs";

const BLOCK_END = "<!-- relo:end -->";
const BLOCK_KEEP = "<!-- relo:keep -->";
// The start line names the modules the block holds: `<!-- relo:start reporting planning -->`. A bare
// `<!-- relo:start -->` (written by older CLIs) holds what track holds today.
const START_LINE = /^<!--\s*relo:start((?:\s+[a-z-]+)*)\s*-->$/u;
const BARE_MODULES = Object.freeze(["reporting", "planning"]);

// The block's text lives once, in blocks/<module>.md (shipped with the package), the heading shared. No
// version numbers or timestamps: a tracked file must not change when Relo does.
const readPart = (name) => readFileSync(new URL(`./blocks/${name}.md`, import.meta.url), "utf8").trimEnd();
/** The modules in the order a block holds them: notify or reporting first (they exclude each other). */
export const MODULES = Object.freeze(["notify", "reporting", "planning", "continuity", "efficiency"]);
const HEADING = readPart("heading");
const TEXTS = Object.freeze(Object.fromEntries(MODULES.map((name) => [name, readPart(name)])));
/** Setup depths as the modules each puts in the block (plan 12 §4.7); hooks and the skill follow in install/plan.mjs. */
export const DEPTHS = Object.freeze({
  notify: Object.freeze(["notify"]),
  track: Object.freeze(["reporting", "planning"]),
  guide: Object.freeze(["reporting", "planning", "continuity"]),
  optimize: Object.freeze(["reporting", "planning", "continuity", "efficiency"]),
});

const sameModules = (left, right) => left.length === right.length && left.every((name, index) => name === right[index]);

/** The depth whose modules these are exactly: notify | track | guide | optimize, else custom (none for no modules). */
export function depthOf(modules) {
  if (!modules || modules.length === 0) return "none";
  return Object.keys(DEPTHS).find((level) => sameModules(DEPTHS[level], modules)) ?? "custom";
}

/** Modules in block order, once each; an unknown module or notify together with reporting is a usage error. */
export function normalizeModules(modules) {
  const names = [...new Set(modules)];
  const unknown = names.filter((name) => !MODULES.includes(name));
  if (unknown.length > 0) throw new UsageError(`Unknown module "${unknown[0]}".`, { hint: `Modules: ${MODULES.join(", ")}` });
  if (names.includes("notify") && names.includes("reporting")) {
    throw new UsageError("The notify and reporting modules exclude each other: one teaches relo notify for outcomes, the other says the outcome is the notification.");
  }
  if (names.length === 0) throw new UsageError("A block needs at least one module.", { hint: `Modules: ${MODULES.join(", ")}` });
  return MODULES.filter((name) => names.includes(name));
}

/** The block's text without its markers: the heading, then each module's lines. */
export const renderBlockText = (modules) => [HEADING, ...normalizeModules(modules).map((name) => TEXTS[name])].join("\n");

/** The block as lines, markers included, for these modules. */
export const renderBlock = (modules) => {
  const names = normalizeModules(modules);
  return [`<!-- relo:start ${names.join(" ")} -->`, ...renderBlockText(names).split("\n"), BLOCK_END];
};

/** The modules a start line names (a bare one: track's), in block order; names this CLI does not know are dropped. */
function startModules(text) {
  const named = START_LINE.exec(text.trim())?.[1].split(/\s+/u).filter(Boolean) ?? [];
  const known = MODULES.filter((name) => named.includes(name));
  return known.length === 0 ? [...BARE_MODULES] : known;
}

/** Lines with their own terminators, so everything outside the block survives byte for byte. */
function splitLines(content) {
  const lines = [];
  let from = 0;
  while (from < content.length) {
    const at = content.indexOf("\n", from);
    const end = at === -1 ? content.length : at + 1;
    const raw = content.slice(from, end);
    const eol = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    lines.push({ text: raw.slice(0, raw.length - eol.length), eol });
    from = end;
  }
  return lines;
}

const alone = (line, marker) => line.text.trim() === marker;
const isStart = (line) => START_LINE.test(line.text.trim());
const isBlank = (line) => line.text.trim() === "";

function findBlock(lines) {
  const start = lines.findIndex(isStart);
  if (start === -1) return { state: "none" };
  const end = lines.findIndex((line, index) => index > start && alone(line, BLOCK_END));
  if (end === -1) return { state: "unterminated", start };
  const kept = lines.slice(start, end + 1).some((line) => alone(line, BLOCK_KEEP));
  return { state: kept ? "kept" : "found", start, end, modules: startModules(lines[start].text) };
}

/** The modules the block in this text (or file path) holds, in block order; [] when there is no block. */
export function blockModules(contentOrPath) {
  let content = contentOrPath;
  if (!/<!--/u.test(contentOrPath)) { try { content = readFileSync(contentOrPath, "utf8"); } catch { return []; } }
  const found = findBlock(splitLines(content));
  return found.state === "found" || found.state === "kept" ? found.modules : [];
}

/** The nearest depth at or below these modules (a custom set counts as the deepest depth it reaches), for "never downgrade". */
export function depthReached(modules) {
  if (modules.length === 0) return undefined;
  if (modules.includes("notify")) return "notify";
  return modules.includes("efficiency") ? "optimize" : modules.includes("continuity") ? "guide" : "track";
}

const serialize = (lines) => lines.map((line) => line.text + line.eol).join("");

/**
 * What installing (or removing) the block does to one file's text: { action, content? }. `modules` is what a new
 * block holds and what an existing one is rewritten to; without it an existing block keeps the modules its own
 * marker names (--refresh), and a new one holds track's. `keepModules` makes an existing block keep its own even
 * when `modules` is given (setup without --level never changes a file's depth).
 */
export function planBlock(content, { remove = false, modules, keepModules = false } = {}) {
  if (content === undefined) {
    return remove ? { action: "skipped" } : { action: "created", content: `${renderBlock(modules ?? DEPTHS.track).join("\n")}\n` };
  }
  const lines = splitLines(content);
  const found = findBlock(lines);
  if (found.state === "unterminated") return { action: "skipped", reason: `${lines[found.start].text.trim()} has no ${BLOCK_END}` };
  if (found.state === "kept") return { action: "kept" };
  if (remove) {
    if (found.state === "none") return { action: "unchanged" };
    let { start, end } = found;
    if (start === 0 && end + 1 < lines.length && isBlank(lines[end + 1])) end += 1;
    const atEnd = lines.slice(end + 1).every(isBlank);
    if (start > 0 && isBlank(lines[start - 1]) && (atEnd || (end + 1 < lines.length && isBlank(lines[end + 1])))) start -= 1;
    const remaining = [...lines.slice(0, start), ...lines.slice(end + 1)];
    return { action: "removed", content: serialize(remaining), empty: remaining.every(isBlank) };
  }
  const eol = (lines.find((line) => line.eol)?.eol) ?? "\n";
  const block = renderBlock(found.state === "found" && (keepModules || !modules) ? found.modules : modules ?? DEPTHS.track);
  if (found.state === "none") {
    if (content === "" ) return { action: "appended", content: `${block.join(eol)}${eol}` };
    const base = lines.map((line, index) => (index === lines.length - 1 && line.eol === "" ? { ...line, eol } : line));
    const blankBefore = isBlank(base[base.length - 1]);
    const text = serialize(base) + (blankBefore ? "" : eol) + block.join(eol) + eol;
    return { action: "appended", content: text };
  }
  const last = lines[found.end];
  const blockEol = lines[found.start].eol || eol;
  const replacement = block.map((text, index) => ({ text, eol: index === block.length - 1 ? last.eol : blockEol }));
  const next = serialize([...lines.slice(0, found.start), ...replacement, ...lines.slice(found.end + 1)]);
  return next === content ? { action: "unchanged" } : { action: "updated", content: next };
}

const isDirectory = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

export function shortPath(path, home) {
  const root = resolve(home);
  return path === root ? "~" : path.startsWith(root + sep) ? `~${path.slice(root.length)}` : path;
}

/** The harnesses with a global instructions file (harness/catalog.mjs). */
const INSTRUCTION_HARNESSES = HARNESSES.filter((harness) => harness.instructions?.global);
const globalPath = (harness, probe) => harnessPath(harness, harness.instructions.global, probe);

const realOrSame = (path) => { try { return realpathSync(path); } catch { return path; } };
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** Claude Code's import line: a CLAUDE.md holding it reads AGENTS.md, so the two are one instruction file. */
const AGENTS_IMPORT = "@AGENTS.md";
const importsAgents = (path) => { try { return readFileSync(path, "utf8").split(/\r?\n/u).some((line) => line.trim() === AGENTS_IMPORT); } catch { return false; } };

/**
 * The repository's one instruction file: the existing one, or a conflict when both hold their own text.
 * A CLAUDE.md that imports AGENTS.md is the same file. With neither, the block goes in AGENTS.md (read by
 * Codex, OpenCode, Amp, Copilot, Cursor). Whenever AGENTS.md has no CLAUDE.md beside it, `companion` is a
 * CLAUDE.md importing it, so Claude Code reads it too.
 */
export function projectFile({ cwd }) {
  const root = repositoryRoot(cwd);
  const [agents, claude] = ["AGENTS.md", "CLAUDE.md"].map((name) => join(root, name));
  if (!isFile(agents) && !isFile(claude)) return { path: agents, root, companion: claude };
  const existing = [agents, claude].filter(isFile).filter((path) => path !== claude || !isFile(agents) || !importsAgents(claude));
  const distinct = existing.filter((path, index) => existing.findIndex((other) => realOrSame(other) === realOrSame(path)) === index);
  if (distinct.length > 1) return { conflict: distinct };
  // AGENTS.md alone: Claude Code reads only CLAUDE.md, so it gets the one-line import too.
  return { path: distinct[0], root, ...(distinct[0] === agents && !isFile(claude) ? { companion: claude } : {}) };
}

/** Creates the CLAUDE.md that imports AGENTS.md (Claude Code reads only CLAUDE.md); an existing one is left alone. */
export async function writeCompanion(path) {
  await writeFile(path, `${AGENTS_IMPORT}\n`, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
}

/** After the block left `path`: a sibling CLAUDE.md that only imports a now missing AGENTS.md goes too. */
export async function removeCompanion(path) {
  if (!path.endsWith(`${sep}AGENTS.md`) || isFile(path)) return;
  const companion = join(dirname(path), "CLAUDE.md");
  try { if ((await readFile(companion, "utf8")).trim() === AGENTS_IMPORT) await rm(companion); } catch { /* none */ }
}

/** Every place a Relo block may live (repository + each supported global file), distinct real files only. */
function candidatePaths({ env, home, cwd, extra = [], globalOnly = false }) {
  const paths = [...extra, ...(globalOnly ? [] : ["AGENTS.md", "CLAUDE.md"].map((name) => join(repositoryRoot(cwd), name))),
    ...INSTRUCTION_HARNESSES.map((harness) => globalPath(harness, { env, home }))];
  const seen = new Set();
  return paths.filter((path) => {
    const real = realOrSame(path);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/** Files that hold a relo block (kept or not). Reads only. */
export function findBlocks({ env, home, cwd, extra, globalOnly }) {
  const found = [];
  for (const path of candidatePaths({ env, home, cwd, extra, globalOnly })) {
    let content;
    try { content = readFileSync(path, "utf8"); } catch { continue; }
    const block = findBlock(splitLines(content));
    if (block.state === "found" || block.state === "kept") found.push({ path, state: block.state, modules: block.modules });
  }
  return found;
}

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Reads one file and decides what the block would do to it; nothing is written. */
export async function planFile(path, options) {
  const current = await readIfPresent(path);
  return { path, current, plan: planBlock(current, options) };
}

/** Writes a plan made by planFile. A file that held only the block goes away with it. */
export async function commitPlan({ path, plan }, { makeDirectory = false } = {}) {
  if (plan.content === undefined) return;
  if (plan.action === "removed" && plan.empty) { await rm(path); return; }
  if (makeDirectory) await mkdir(dirname(path), { recursive: true });
  await writeFile(path, plan.content);
}

