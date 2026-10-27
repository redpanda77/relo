// Private folders on Windows. Mode 0700/0600 means nothing there, so Relo's own folders (the config folder,
// %APPDATA%\relo, which also holds the key store, and the state/data folder, %LOCALAPPDATA%\Relo) get an ACL that
// grants only the current user, once: a marker file inside the folder remembers that it ran (success or failure),
// so a hook never runs icacls again. Only those two default folders are ever touched: a folder the owner moved with
// RELO_CONFIG_PATH, RELO_STATE_DIR or XDG_STATE_HOME is theirs. Imports only node built-ins (the hook path loads this).
import { existsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export const ACL_MARKER = ".relo-acl";
const ICACLS_TIMEOUT_MS = 5_000;

/** The default Relo folders on win32: the config folder and the state/data root. Empty elsewhere. */
export function defaultPrivateRoots({ env = process.env, platform = process.platform } = {}) {
  if (platform !== "win32") return [];
  return [env.APPDATA?.trim() && join(env.APPDATA.trim(), "relo"), env.LOCALAPPDATA?.trim() && join(env.LOCALAPPDATA.trim(), "Relo")].filter(Boolean);
}

const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** The default Relo folder that is `dir` or holds it, or undefined. */
export function privateRootOf(dir, options) {
  const lower = resolve(dir).toLowerCase();
  return defaultPrivateRoots(options).find((root) => same(root, lower) || lower.startsWith(`${resolve(root).toLowerCase()}${sep}`));
}

/** DOMAIN\user from the environment, or undefined. */
export function windowsUser(env = process.env) {
  const name = env.USERNAME?.trim();
  if (!name) return undefined;
  const domain = env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${name}` : name;
}

export function icaclsPath(env = process.env) {
  return env.SystemRoot ? join(env.SystemRoot, "System32", "icacls.exe") : "icacls";
}

/** icacls arguments that make `dir` (and what it will hold) the current user's alone: no inheritance, one full-control grant. */
export const restrictArguments = (dir, user) => [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`];

function execFileOnce(file, args, options) {
  return import("node:child_process").then(({ execFile }) => new Promise((resolveRun) => {
    execFile(file, args, { windowsHide: true, timeout: ICACLS_TIMEOUT_MS, encoding: "utf8", ...options }, (error, stdout) => resolveRun({ ok: !error, stdout: String(stdout ?? "") }));
  }));
}

/**
 * Restricts the default Relo folder holding `dir` to the current user, once. Win32 only; fails soft (never throws).
 * Returns "restricted", "done" (marker present), "failed", or "skipped" (not win32, not a default folder, no user).
 * Options: { platform, env, run(file, args) -> { ok, stdout }, force } (force: setup re-applies despite the marker).
 */
export async function restrictToCurrentUser(dir, { platform = process.platform, env = process.env, run = execFileOnce, force = false } = {}) {
  try {
    const root = privateRootOf(dir, { env, platform });
    if (!root) return "skipped";
    const marker = join(root, ACL_MARKER);
    if (!force && existsSync(marker)) return "done";
    const user = windowsUser(env) ?? (await run("whoami", [])).stdout.trim();
    if (!user) return "skipped";
    const result = await run(icaclsPath(env), restrictArguments(root, user));
    try { writeFileSync(marker, result.ok ? "ok\n" : "failed\n"); } catch { /* the folder is still usable */ }
    return result.ok ? "restricted" : "failed";
  } catch {
    return "failed";
  }
}

/** mkdir -p (mode 0700), then the win32 ACL once for the default Relo folders. */
export async function ensurePrivateDirectory(dir, options = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return restrictToCurrentUser(dir, options);
}

/** `relo setup`: creates and restricts both default folders, re-applying the ACL. */
export async function restrictDefaultDirectories(options = {}) {
  const results = {};
  for (const root of defaultPrivateRoots(options)) {
    try { await mkdir(root, { recursive: true, mode: 0o700 }); } catch { continue; }
    results[root] = await restrictToCurrentUser(root, { ...options, force: true });
  }
  return results;
}

const BROAD = /^(everyone|todos|tout le monde|jeder|nt authority\\authenticated users|builtin\\users|builtin\\usuarios|.*\\users|.*\\domain users)$/iu;
const SAFE = /^(nt authority\\system|nt-autorit.*\\system|creator owner|.*\\administrators|.*\\administradores|.*\\administrateurs|.*\\administratoren)$/iu;

/** The principals other than the owner, SYSTEM and Administrators that `icacls <dir>` output grants access (DENY entries skipped). */
export function otherPrincipals(output, { dir, user } = {}) {
  const found = [];
  for (const raw of String(output).split(/\r?\n/u)) {
    let line = raw.trim();
    if (!line || /^successfully processed/iu.test(line)) continue;
    if (dir && line.toLowerCase().startsWith(dir.toLowerCase())) line = line.slice(dir.length).trim();
    const match = /^(.+?):(\(.*)$/u.exec(line);
    if (!match || /\(DENY\)/iu.test(match[2])) continue;
    const principal = match[1].trim();
    const mine = user && (principal.toLowerCase() === user.toLowerCase() || principal.toLowerCase().endsWith(`\\${user.split("\\").pop().toLowerCase()}`));
    if (mine || SAFE.test(principal)) continue;
    if (BROAD.test(principal) || principal) found.push(principal);
  }
  return [...new Set(found)];
}

/** `relo doctor`: { ok, state, ... } for the config folder's ACL on win32, or undefined elsewhere / when icacls cannot say. */
export async function inspectConfigAcl(dir, { platform = process.platform, env = process.env, run = execFileOnce } = {}) {
  if (platform !== "win32") return undefined;
  try {
    const result = await run(icaclsPath(env), [dir]);
    if (!result.ok) return undefined;
    const others = otherPrincipals(result.stdout, { dir, user: windowsUser(env) });
    if (others.length === 0) return { ok: true, state: "private" };
    return { ok: false, state: `readable by ${others.join(", ")}`, hint: "Restrict the Relo folder to your account: relo setup", run: "relo setup" };
  } catch {
    return undefined;
  }
}
