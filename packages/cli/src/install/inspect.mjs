// What relo doctor reports about what relo setup wrote: one read-only pass over the same files. Each
// warning is advice, never a failure: a stale block or skill, hooks an older CLI installed, presence hooks
// with no harness credential, MCP entries that point at a node or relo that moved, and a `relo` on PATH that
// is not this CLI. Every one names the command that fixes it. Doctor never suggests adding hooks or MCP.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { ADAPTERS } from "../harness/adapters/index.mjs";
import { detectHarness, presentHarnesses } from "../harness/catalog.mjs";
import { inferLevel } from "../harness/core/install.mjs";
import { repositoryRoot } from "../shared/repo.mjs";
import { findBlocks, planBlock, shortPath } from "./block.mjs";
import { findHooks } from "./hooks.mjs";
import { findMcp } from "./mcp.mjs";

const REFRESH = "relo setup --refresh";
const real = (path) => { try { return realpathSync(path); } catch { return path; } };
const read = (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };

/**
 * The blocks setup wrote: current, stale (relo setup --refresh), kept, or hidden: a project AGENTS.md that
 * Claude Code never reads, because the repository has no CLAUDE.md that imports it.
 */
export function inspectBlocks(probe) {
  const root = repositoryRoot(probe.cwd);
  const claudeHere = [detectHarness(probe.env ?? {}), ...presentHarnesses(probe)].some((harness) => harness?.id === "claude-code");
  const claudeFile = read(join(root, "CLAUDE.md"));
  const files = findBlocks(probe).map(({ path, state, modules }) => {
    if (state === "kept") return { file: shortPath(path, probe.home), state: "kept", modules };
    const hidden = claudeHere && real(path) === real(join(root, "AGENTS.md")) && real(join(root, "CLAUDE.md")) !== real(path)
      && !(claudeFile ?? "").split(/\r?\n/u).some((line) => line.trim() === "@AGENTS.md");
    const stale = planBlock(read(path)).action === "updated";
    return { file: shortPath(path, probe.home), state: hidden ? "hidden" : stale ? "stale" : "current", modules };
  });
  if (files.length === 0) return { ok: true, state: "none" };
  const hidden = files.find((file) => file.state === "hidden");
  const stale = files.find((file) => file.state === "stale");
  return {
    ok: !hidden && !stale, state: hidden ? "hidden" : stale ? "stale" : "set", files,
    ...(hidden ? { hint: `${hidden.file} is not read by Claude Code: relo setup --project adds a CLAUDE.md that imports it` }
      : stale ? { hint: `${stale.file} holds an older Relo block: ${REFRESH}` } : {}),
  };
}

/** Hook files: the level each holds; drifted or older entries are stale; presence needs the harness credential. */
export function inspectHooksInstall(probe, { credential }) {
  const files = findHooks(probe).map((found) => {
    const { level, nearest } = inferLevel(found.settings, ADAPTERS[found.agent]);
    return { file: shortPath(found.path, probe.home), agent: found.agent, level, events: found.events, ...(nearest ? { nearest } : {}) };
  });
  if (files.length === 0) return { ok: true, state: "none" };
  const stale = files.find((file) => file.level === "custom" && file.nearest);
  const legacy = files.find((file) => file.level === "legacy");
  const sending = files.some((file) => ADAPTERS[file.agent].install.sending.includes(file.level));
  const hint = stale ? `${stale.file} holds older Relo hook entries: ${REFRESH}`
    : legacy ? `${legacy.file} holds hooks from an older Relo: relo setup --level guide (or --level track to drop them)`
      : sending && !credential ? "presence hooks need this computer's harness credential: relo setup --level guide" : undefined;
  return { ok: hint === undefined, state: hint ? "stale" : "set", files, ...(hint ? { hint } : {}) };
}

/** MCP entries: a GUI app's entry names node and relo.mjs by path; when either moved, it is stale. */
export function inspectMcpInstall(probe, { nodePath, entrypoint }) {
  const files = findMcp(probe).map(({ path, agent, entry }) => {
    const absolute = typeof entry?.command === "string" && isAbsolute(entry.command);
    const stale = absolute && (!existsSync(entry.command) || entry.args?.[0] !== entrypoint || real(entry.command) !== real(nodePath ?? entry.command));
    return { file: shortPath(path, probe.home), agent, state: stale ? "stale" : "current", ...(entry?.command === "relo" ? { runs: "relo" } : {}) };
  });
  if (files.length === 0) return { ok: true, state: "none" };
  const stale = files.find((file) => file.state === "stale");
  return { ok: !stale, state: stale ? "stale" : "set", files, ...(stale ? { hint: `${stale.file} points at a node or relo that moved: ${REFRESH}` } : {}) };
}

/** The `relo` a hook or a shell MCP entry runs: the first on PATH. Stale when it is not this CLI. */
export function inspectPath({ env, entrypoint }) {
  for (const folder of String(env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(folder, "relo");
    try { if (!statSync(candidate).isFile()) continue; } catch { continue; }
    // The install script's launcher (Add a computer) names this CLI by path: "# relo launcher: <relo.mjs>".
    const launched = read(candidate)?.match(/^# relo launcher: (.+)$/mu)?.[1];
    return real(candidate) === real(entrypoint) || (launched && real(launched) === real(entrypoint)) ? { ok: true, state: "this" }
      : { ok: false, state: "other", relo: candidate, hint: `hooks and MCP run ${candidate}, not this CLI: reinstall relo, or fix PATH` };
  }
  return { ok: false, state: "missing", hint: "relo is not on PATH, so hooks and MCP entries cannot run it" };
}

const SCRIPT_TARGET = /(?:^|[\s"'])(\/[^\s"']*?\/bin\/relo\.mjs|[A-Za-z]:\\[^\s"']*?\\bin\\relo\.mjs)(?=$|[\s"'])/mu;
const numbers = (version) => String(version).split(/[.+-]/u).map((part) => Number.parseInt(part, 10) || 0);
const compare = (a, b) => { const x = numbers(a), y = numbers(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; } return 0; };

/** The package a `relo` file belongs to, read without running it: a node script's own package, or the relo.mjs a launcher execs. */
function installOf(file) {
  const resolved = real(file);
  const text = read(resolved);
  const target = text?.startsWith("#!") && !/^#!.*\bnode\b/mu.test(text.split("\n", 1)[0]) ? text.match(SCRIPT_TARGET)?.[1] : undefined;
  const script = target ? real(target) : resolved;
  let version;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(script), "..", "package.json"), "utf8"));
    if (pkg?.name === "@relo/cli" && typeof pkg.version === "string") version = pkg.version;
  } catch { /* unknown */ }
  const root = join(dirname(script), "..");
  const kind = /\.app[\\/]/u.test(root) ? "app" : /[\\/](?:Cellar|homebrew)[\\/]/u.test(root) ? "brew" : /[\\/]node_modules[\\/]/u.test(root) ? "npm" : "other";
  return { id: script, version, kind };
}

const REMOVE = { brew: "brew uninstall relo", npm: "npm uninstall --global @relo/cli" };

/**
 * Every `relo` on PATH, one row per install (a launcher and the copy it execs count once). Several installs, or a first
 * one older than the newest, is advice: hooks run the first, so an old copy silently runs them with old behaviour.
 */
export function inspectRelos({ env }) {
  const installs = [];
  for (const folder of String(env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(folder, "relo");
    try { if (!statSync(candidate).isFile()) continue; } catch { continue; }
    const found = installOf(candidate);
    const existing = installs.find((install) => install.id === found.id);
    if (existing) existing.also.push(candidate); else installs.push({ ...found, path: candidate, also: [] });
  }
  const rows = installs.map(({ path, version, kind, also }) => ({ path, version: version ?? "unknown", kind, ...(also.length ? { also } : {}) }));
  if (rows.length < 2) return { ok: true, state: "one", installs: rows };
  const known = rows.filter((row) => row.version !== "unknown");
  const newest = known.reduce((best, row) => (best === undefined || compare(row.version, best.version) > 0 ? row : best), undefined);
  const first = rows[0];
  const older = newest !== undefined && first.version !== "unknown" && compare(first.version, newest.version) < 0;
  const keep = rows.find((row) => row.kind === "app") ?? newest ?? first;
  const removals = rows.filter((row) => row !== keep && REMOVE[row.kind]).map((row) => `${row.path}: ${REMOVE[row.kind]}`);
  const list = rows.map((row) => `${row.path} ${row.version}`).join("; ");
  const hint = `${rows.length} relo commands on PATH (${list}). Hooks and agents run the first, ${first.path} ${first.version}`
    + `${older ? `, which is older than ${newest.version}` : ""}. Keep one${keep.kind === "app" ? " (the one in Relo for Mac)" : ` (${keep.path})`} and remove the others`
    + `${removals.length ? `: ${removals.join("; ")}` : ""}`;
  return { ok: false, state: older ? "older_first" : "several", first: first.path, installs: rows, hint };
}
