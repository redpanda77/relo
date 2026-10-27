// How a harness is told to run Relo's own commands (`relo hook <role>`, `relo statusline`). On POSIX the command is
// the bare `relo ...` (byte-stable), unless Relo for Mac runs setup with RELO_HOOK_LAUNCHER, its own launcher
// (~/.local/bin/relo, which follows the app): then `"<launcher>" hook <role>`, so the hooks run the app's relo and
// every app update updates them, whatever other relo comes first on the harness's PATH. On Windows `relo` depends on the PATH of whichever shell the harness uses
// (Git Bash, PowerShell or cmd), so setup writes this CLI by absolute path instead: `"<node>" "<relo.mjs>" hook <role>`,
// forward slashes and double quotes, which Git Bash and cmd both run. Recognition accepts both forms, so setup
// replaces either one and uninstall removes either one.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const forward = (path) => String(path).replaceAll("\\", "/");

/** The command prefix for `launch` ({ nodePath, entrypoint, platform }): undefined where the bare `relo` is used. */
export function launchPrefix({ nodePath, entrypoint, launcher, platform = process.platform } = {}) {
  if (platform !== "win32" && typeof launcher === "string" && launcher.startsWith("/") && !launcher.includes('"')) return `"${launcher}"`;
  if (platform !== "win32" || !nodePath || !entrypoint) return undefined;
  return `"${forward(nodePath)}" "${forward(entrypoint)}"`;
}

/** `relo <rest>` for the harness to run, e.g. rest = "hook guard" or "statusline". */
export const reloCommand = (rest, launch) => `${launchPrefix(launch) ?? "relo"} ${rest}`;

const ABSOLUTE = /^(?:"[^"]+" "[^"]*relo\.mjs"|"\/[^"]*\/relo") (?=(?:hook |statusline$))/u;

/** The part after `relo ` of a Relo command in either form (`hook guard`, `statusline`); undefined for anything else. */
export function reloRest(command) {
  if (typeof command !== "string") return undefined;
  if (command.startsWith("relo ")) return command.slice(5);
  const match = ABSOLUTE.exec(command);
  return match ? command.slice(match[0].length) : undefined;
}

/** Whether `command` is a Relo hook command (bare or absolute). */
export const isReloHookCommand = (command) => reloRest(command)?.startsWith("hook ") === true;

/** Whether `command` is Relo's status line wrapper (bare or absolute). */
export const isReloStatusline = (command) => reloRest(command) === "statusline";

/** The bare `relo ...` spelling of a Relo command in either form; other commands come back as they are. */
export const bareCommand = (command) => { const rest = reloRest(command); return rest === undefined ? command : `relo ${rest}`; };

/** Relo for Mac's launcher (`~/.local/bin/relo`, a regular file carrying its marker line), or undefined. */
export function appLauncher(home) {
  if (typeof home !== "string" || !home) return undefined;
  const path = join(home, ".local", "bin", "relo");
  try {
    if (!lstatSync(path).isFile()) return undefined;
    return /^# Written by Relo for Mac\s*$/mu.test(readFileSync(path, "utf8")) ? path : undefined;
  } catch { return undefined; }
}

/** The absolute launcher an existing hooks/settings file already names, when that file still exists. */
export function keptLauncher(text) {
  if (typeof text !== "string") return undefined;
  const found = /\\?"(\/[^"\\]+\/relo)\\?" (?:hook |statusline)/u.exec(text)?.[1];
  return found && existsSync(found) ? found : undefined;
}

/**
 * The launcher setup writes into hooks: RELO_HOOK_LAUNCHER, else Relo for Mac's own launcher, else the absolute one
 * `existingText` (the file being refreshed) already uses while its target exists. Undefined on Windows or when none.
 */
export function resolveLauncher({ env, home, platform = process.platform } = {}, existingText) {
  if (platform === "win32") return env?.RELO_HOOK_LAUNCHER;
  return env?.RELO_HOOK_LAUNCHER || appLauncher(home) || keptLauncher(existingText);
}
