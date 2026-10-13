// `relo setup`: a short, marked instruction block in ONE instruction file the owner chooses, so an
// agent knows Relo exists before the skill triggers. Only text between the markers is ever touched.
// Never automatic: nothing but `relo setup` writes it, and doctor never suggests running it.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const BLOCK_START = "<!-- relo:start -->";
export const BLOCK_END = "<!-- relo:end -->";
export const BLOCK_KEEP = "<!-- relo:keep -->";

// No version numbers or timestamps: a tracked file must not change when Relo does.
export const BLOCK_LINES = [
  BLOCK_START,
  "## Relo (live status on the owner's iPhone)",
  "For work longer than a couple of minutes, keep one Relo card current; ask on it before risky actions.",
  '- `relo activity start --title "…" --status "…" --steps "A,B,C" --topic "<the work>"` → `update --status … --next-step` → `end --status "…"`',
  "- Judgment work: `--steps` (3-6 named phases). A counted job (10 images, 400 rows): `--progress 3/10`. Never both.",
  '- `relo ask "Deploy to production?" --approval`: only exit 0 with state `approved` is permission; anything else means no.',
  '- `relo notify "…"` only for a finished outcome worth a buzz. Never put secrets, paths or raw output in card text.',
  "- Details: the relo-notifications skill, or `relo help`.",
  BLOCK_END,
];

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
const isBlank = (line) => line.text.trim() === "";

function findBlock(lines) {
  const start = lines.findIndex((line) => alone(line, BLOCK_START));
  if (start === -1) return { state: "none" };
  const end = lines.findIndex((line, index) => index > start && alone(line, BLOCK_END));
  if (end === -1) return { state: "unterminated", start };
  const kept = lines.slice(start, end + 1).some((line) => alone(line, BLOCK_KEEP));
  return { state: kept ? "kept" : "found", start, end };
}

const serialize = (lines) => lines.map((line) => line.text + line.eol).join("");

/** What installing (or removing) the block does to one file's text: { action, content? }. */
export function planBlock(content, { remove = false } = {}) {
  if (content === undefined) return remove ? { action: "skipped" } : { action: "created", content: `${BLOCK_LINES.join("\n")}\n` };
  const lines = splitLines(content);
  const found = findBlock(lines);
  if (found.state === "unterminated") return { action: "skipped", reason: `${BLOCK_START} has no ${BLOCK_END}` };
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
  if (found.state === "none") {
    if (content === "" ) return { action: "appended", content: `${BLOCK_LINES.join(eol)}${eol}` };
    const base = lines.map((line, index) => (index === lines.length - 1 && line.eol === "" ? { ...line, eol } : line));
    const blankBefore = isBlank(base[base.length - 1]);
    const text = serialize(base) + (blankBefore ? "" : eol) + BLOCK_LINES.join(eol) + eol;
    return { action: "appended", content: text };
  }
  const last = lines[found.end];
  const blockEol = lines[found.start].eol || eol;
  const replacement = BLOCK_LINES.map((text, index) => ({ text, eol: index === BLOCK_LINES.length - 1 ? last.eol : blockEol }));
  const next = serialize([...lines.slice(0, found.start), ...replacement, ...lines.slice(found.end + 1)]);
  return next === content ? { action: "unchanged" } : { action: "updated", content: next };
}

const isDirectory = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

export function shortPath(path, home) {
  const root = resolve(home);
  return path === root ? "~" : path.startsWith(root + sep) ? `~${path.slice(root.length)}` : path;
}

export function expandPath(path, home, cwd) {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return resolve(cwd, path);
}

const configured = (env, name, fallback) => (env[name]?.trim() ? resolve(env[name].trim()) : fallback);

/**
 * Each harness's one global instructions file. Paths come from the harness's own documentation:
 * Claude Code (CLAUDE_CONFIG_DIR or ~/.claude, CLAUDE.md), Codex (CODEX_HOME or ~/.codex, AGENTS.md),
 * Gemini CLI (~/.gemini/GEMINI.md, google-gemini/gemini-cli docs "GEMINI.md"), OpenCode
 * (~/.config/opencode/AGENTS.md, opencode.ai/docs/rules), GitHub Copilot CLI (COPILOT_HOME or ~/.copilot,
 * copilot-instructions.md, docs.github.com "Add custom instructions"), Amp (~/.config/amp/AGENTS.md,
 * ampcode.com/docs/customize/agents-md). Anything else: `relo setup --file PATH`.
 */
export const GLOBAL_AGENTS = {
  "claude-code": { aliases: ["claude"], file: ({ env, home }) => join(configured(env, "CLAUDE_CONFIG_DIR", join(home, ".claude")), "CLAUDE.md") },
  codex: { aliases: [], file: ({ env, home }) => join(configured(env, "CODEX_HOME", join(home, ".codex")), "AGENTS.md") },
  gemini: { aliases: ["gemini-cli"], file: ({ home }) => join(home, ".gemini", "GEMINI.md") },
  opencode: { aliases: [], file: ({ home }) => join(home, ".config", "opencode", "AGENTS.md") },
  copilot: { aliases: ["github-copilot", "copilot-cli"], file: ({ env, home }) => join(configured(env, "COPILOT_HOME", join(home, ".copilot")), "copilot-instructions.md") },
  amp: { aliases: [], file: ({ home }) => join(home, ".config", "amp", "AGENTS.md") },
};

export const GLOBAL_AGENT_NAMES = Object.keys(GLOBAL_AGENTS);

export function globalFile(agent, { env, home }) {
  const wanted = String(agent).trim().toLowerCase();
  const name = GLOBAL_AGENT_NAMES.find((key) => key === wanted || GLOBAL_AGENTS[key].aliases.includes(wanted));
  return name === undefined ? undefined : { agent: name, path: GLOBAL_AGENTS[name].file({ env, home }) };
}

export function repositoryRoot(cwd) {
  let directory = resolve(cwd);
  for (;;) {
    try { statSync(join(directory, ".git")); return directory; } catch { /* keep climbing */ }
    const parent = dirname(directory);
    if (parent === directory) return resolve(cwd);
    directory = parent;
  }
}

const realOrSame = (path) => { try { return realpathSync(path); } catch { return path; } };
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** The repository's one instruction file: the existing one, AGENTS.md when neither exists, or a conflict when both do. */
export function projectFile({ cwd }) {
  const root = repositoryRoot(cwd);
  const candidates = ["AGENTS.md", "CLAUDE.md"].map((name) => join(root, name));
  const existing = candidates.filter(isFile);
  const distinct = existing.filter((path, index) => existing.findIndex((other) => realOrSame(other) === realOrSame(path)) === index);
  if (distinct.length > 1) return { conflict: distinct };
  return { path: distinct[0] ?? existing[0] ?? candidates[0], root };
}

/** Every place a Relo block may live (repository + each supported global file), distinct real files only. */
function candidatePaths({ env, home, cwd, extra = [] }) {
  const paths = [...extra, ...["AGENTS.md", "CLAUDE.md"].map((name) => join(repositoryRoot(cwd), name)),
    ...GLOBAL_AGENT_NAMES.map((name) => GLOBAL_AGENTS[name].file({ env, home }))];
  const seen = new Set();
  return paths.filter((path) => {
    const real = realOrSame(path);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/** Files that hold a relo block (kept or not). Reads only. */
export function findBlocks({ env, home, cwd, extra }) {
  const found = [];
  for (const path of candidatePaths({ env, home, cwd, extra })) {
    let content;
    try { content = readFileSync(path, "utf8"); } catch { continue; }
    const state = findBlock(splitLines(content)).state;
    if (state === "found" || state === "kept") found.push({ path, state });
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
export async function planFile(path, { remove }) {
  const current = await readIfPresent(path);
  return { path, current, plan: planBlock(current, { remove }) };
}

/** Writes a plan made by planFile. A file that held only the block goes away with it. */
export async function commitPlan({ path, plan }, { makeDirectory = false } = {}) {
  if (plan.content === undefined) return;
  if (plan.action === "removed" && plan.empty) { await rm(path); return; }
  if (makeDirectory) await mkdir(dirname(path), { recursive: true });
  await writeFile(path, plan.content);
}

/** Whether a relo block is set up anywhere (informational, for `relo doctor --full`). Reads only. */
export function inspectAgentSetup({ env, home, cwd = process.cwd() }) {
  const found = findBlocks({ env, home, cwd });
  return found.length === 0 ? { state: "none" } : { state: "set", file: shortPath(found[0].path, home) };
}

export async function pathExists(path) {
  try { await stat(path); return true; } catch { return false; }
}
