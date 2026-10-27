// The Windows layout, the counterpart of the install script's ~/.local/share/relo + ~/.local/bin/relo:
//   %LOCALAPPDATA%\Relo\node\node.exe          Node (a private copy, when the system has none)
//   %LOCALAPPDATA%\Relo\cli\<version>\bin\relo.mjs
//   %LOCALAPPDATA%\Relo\bin\relo.cmd           the launcher; names Node and the entry by absolute path, because hooks and
//                                              services run without the shell's PATH
//   %LOCALAPPDATA%\Relo\bin\relo               a sibling sh launcher so `relo` also resolves in Git Bash (bash does not
//                                              run a bare name as relo.cmd)
// A relo.cmd carrying "Written by Relo for Windows" belongs to the Windows app: recognised, never written here.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { renameWithRetry } from "../shared/atomic-write.mjs";

export const WINDOWS_MANAGED_MARKER = "Written by Relo for Windows";

// A Windows folder (C:\x, \\server\share) joins with backslashes on any host, so setup computed on Windows and its tests
// on macOS or Linux agree; a POSIX folder (a test's temporary home) joins as the host does.
const joinFor = (base) => (/^([A-Za-z]:[\\/]|\\\\)/u.test(base) ? win32.join : join);
const localAppData = (env = {}, home) => env.LOCALAPPDATA?.trim() || joinFor(home)(home, "AppData", "Local");

/** { root, bin, cli, cmd, sh } for this user; `env` is the injected one, so a test home never reaches the real folder. */
export function windowsPaths({ home, env = {} }) {
  const base = localAppData(env, home);
  const at = joinFor(base);
  const root = at(base, "Relo");
  return { root, bin: at(root, "bin"), cli: at(root, "cli"), cmd: at(root, "bin", "relo.cmd"), sh: at(root, "bin", "relo") };
}

export const cmdLauncherText = (node, entry) => `@echo off\r\nrem relo launcher: ${entry}\r\n"${node}" "${entry}" %*\r\n`;
const slashed = (path) => path.replaceAll("\\", "/");
export const shLauncherText = (node, entry) => `#!/bin/sh\n# relo launcher: ${slashed(entry)}\nexec "${slashed(node)}" "${slashed(entry)}" "$@"\n`;

/** { node, entry, managed } from a relo.cmd, or undefined when it is not a Relo launcher. */
export function parseCmdLauncher(text) {
  const managed = text.includes(WINDOWS_MANAGED_MARKER);
  const entry = /^rem relo launcher: (.+?)\r?$/mu.exec(text)?.[1];
  const node = /^"([^"]+)" "[^"]+" %\*\r?$/mu.exec(text)?.[1];
  return (entry && node) || managed ? { node, entry, managed } : undefined;
}

/** Writes `contents` to `path` through a temp name and renameWithRetry (the launcher may be running right now). */
async function replaceFile(path, contents, options) {
  const next = `${path}.${process.pid}.tmp`;
  await writeFile(next, contents);
  try { await renameWithRetry(next, path, options); } catch (error) { await rm(next, { force: true }).catch(() => {}); throw error; }
}

/** Points relo.cmd (and the Git Bash sibling) at node + entry. Leaves a launcher the Windows app wrote alone. */
export async function writeWindowsLauncher({ home, env, node, entry, platform = "win32", sleep }) {
  const paths = windowsPaths({ home, env });
  const existing = await readFile(paths.cmd, "utf8").catch(() => undefined);
  if (existing !== undefined && parseCmdLauncher(existing)?.managed) return { path: paths.cmd, written: false, managed: true };
  await mkdir(paths.bin, { recursive: true });
  const options = { platform, ...(sleep ? { sleep } : {}) };
  await replaceFile(paths.cmd, cmdLauncherText(node, entry), options);
  await replaceFile(paths.sh, shLauncherText(node, entry), options);
  return { path: paths.cmd, written: true, managed: false };
}
