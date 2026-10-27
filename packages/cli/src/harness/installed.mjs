// Is a harness installed on this computer? (not "is Relo running inside it": that is a descriptor's detect(env).)
// A harness counts only on evidence of its own: its app or command-line program, a folder or file only it creates,
// or its own config folder, with the entries Relo itself writes there left out (so a folder Relo made for it never
// proves it is installed) and never a folder shared with another harness (Gemini CLI and Antigravity both use
// ~/.gemini). The data is each descriptor's `installation`; this file is the one engine that reads it.
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import { HARNESSES, detectHarness } from "./catalog.mjs";
import { configDirectory, harnessPath } from "./paths.mjs";

const exists = (path) => { try { return statSync(path) !== undefined; } catch { return false; } };
const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** The folders a program of the owner's may live in: PATH, the usual user-level install folders, and on the real home the system ones. */
function programFolders({ env = {}, home, platform = process.platform }) {
  const win = platform === "win32";
  const split = String(env.PATH ?? env.Path ?? "").split(win ? ";" : delimiter).filter(Boolean);
  const own = ["~/.local/bin", "~/.bun/bin", "~/.npm-global/bin", "~/.claude/local", "~/.opencode/bin", "~/.cursor/bin"]
    .map((folder) => (win ? win32 : posix).join(home, folder.slice(2)));
  // A GUI app starts programs with a short PATH; Homebrew's folders matter then. Only on the real home: a test's fake home stays closed.
  const system = platform !== "win32" && home === homedir() ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
  return [...split, ...own, ...system];
}

function hasProgram(name, probe) {
  const win = (probe.platform ?? process.platform) === "win32";
  const suffixes = win ? ["", ".exe", ".cmd", ".bat"] : [""];
  return programFolders(probe).some((folder) => suffixes.some((suffix) => isFile((win ? win32 : posix).join(folder, `${name}${suffix}`))));
}

function hasApp(name, probe) {
  if ((probe.platform ?? process.platform) !== "darwin") return false;
  // /Applications is the real machine's: a fake home in a test never sees it.
  return exists(join(probe.home, "Applications", name)) || (probe.home === homedir() && exists(`/Applications/${name}`));
}

/** The config folder counts: it exists and holds something besides what Relo writes there (or is empty). */
function folderCounts(harness, folder, probe) {
  const directory = configDirectory(harness, probe)?.directory;
  if (!directory) return false;
  let entries;
  try { entries = readdirSync(directory); } catch { return false; }
  const ignore = new Set(folder.ignore ?? []);
  return entries.length === 0 || entries.some((name) => !ignore.has(name));
}

/**
 * Whether this harness is installed here, and by what evidence: { installed, by } with by one of "running" (this very
 * command runs inside it), "program", "app", "marker", "folder"; { installed: false } otherwise. A descriptor with no
 * `installation` (the shared skills folder, the MCP server, VS Code) is never "installed": it is no agent of its own.
 */
export function installation(harness, probe) {
  const spec = harness.installation;
  if (!spec) return { installed: false };
  if (detectHarness(probe.env ?? {})?.id === harness.id) return { installed: true, by: "running" };
  if ((spec.binaries ?? []).some((name) => hasProgram(name, probe))) return { installed: true, by: "program" };
  if ((spec.apps ?? []).some((name) => hasApp(name, probe))) return { installed: true, by: "app" };
  if ((spec.markers ?? []).some((marker) => exists(harnessPath(harness, marker, probe) ?? ""))) return { installed: true, by: "marker" };
  if (spec.folder && folderCounts(harness, spec.folder, probe)) return { installed: true, by: "folder" };
  return { installed: false };
}

export const isInstalled = (harness, probe) => installation(harness, probe).installed;

/** The harnesses installed on this computer, in catalog order. */
export const installedHarnesses = (probe) => HARNESSES.filter((harness) => isInstalled(harness, probe));
