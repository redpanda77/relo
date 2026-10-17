// Automatic CLI updates: the owner deploys a server, and every computer signed in to it follows. The server names the
// newest CLI it hands out on each API reply (x-relo-cli-latest), so noticing costs no request of its own. A CLI the
// install script installed (versions side by side under ~/.local/share/relo/cli, one launcher) then starts one detached
// `relo update --auto`: it verifies the server's tarball, unpacks it beside the running version and swaps the launcher
// with a rename, so a command already running keeps its own files and the next one runs the new version. One updater
// at a time (a lock), one attempt per version an hour (the state file), so neither racing processes nor a failing
// download hammer the server. npm installs replace files in place under running processes: they are told, not updated.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { dataRoot } from "../work/state-file.mjs";

const LOCK_STALE_MS = 10 * 60_000;
export const RETRY_MS = 3_600_000; // an hour

const paths = (home) => ({ directory: dataRoot(home), lock: join(dataRoot(home), "auto-update.lock"), state: join(dataRoot(home), "auto-update.json") });

/** True when this CLI runs from the install script's versioned folders (the layout an update can swap atomically). */
export function launcherManaged({ home, entrypoint }) {
  const root = resolve(join(dataRoot(home), "cli"));
  return typeof entrypoint === "string" && resolve(entrypoint).startsWith(`${root}${sep}`);
}

/**
 * Starts one detached `relo update --auto` when the server offers a newer CLI and nothing stops it; returns whether
 * it started. compare: compareVersions. Never throws.
 */
export function maybeStartAutoUpdate({ latest, version, home, entrypoint, env = {}, now = Date.now(), compare, spawnImpl = spawn }) {
  try {
    if (!latest || !version || env.RELO_NO_UPDATE_CHECK === "1" || compare(latest, version) <= 0) return false;
    if (!launcherManaged({ home, entrypoint })) return false;
    const { directory, lock, state } = paths(home);
    try {
      const last = JSON.parse(readFileSync(state, "utf8"));
      if (last?.target === latest && now - Date.parse(last.at) < RETRY_MS) return false;
    } catch { /* never tried */ }
    try { if (now - statSync(lock).mtimeMs < LOCK_STALE_MS) return false; } catch { /* no updater running */ }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(state, JSON.stringify({ target: latest, from: version, at: new Date(now).toISOString() }), { mode: 0o600 });
    const child = spawnImpl(process.execPath, [entrypoint, "update", "--auto"], { detached: true, stdio: "ignore", env: { ...process.env, ...env } });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/** For `relo update --auto`: holds the lock for the run (the returned release function), or undefined when another holds it. */
export function acquireUpdateLock(home, now = Date.now()) {
  const { directory, lock } = paths(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") return undefined;
      try { if (now - statSync(lock).mtimeMs < LOCK_STALE_MS) return undefined; } catch { /* gone meanwhile */ }
      rmSync(lock, { force: true });
    }
  }
  return undefined;
}

/** Records how the last automatic update ended (doctor reads it). */
export function recordAutoUpdate(home, outcome, now = Date.now()) {
  try {
    const { state } = paths(home);
    let last = {};
    try { last = JSON.parse(readFileSync(state, "utf8")); } catch { /* none */ }
    writeFileSync(state, JSON.stringify({ ...last, ...outcome, endedAt: new Date(now).toISOString() }), { mode: 0o600 });
  } catch { /* best effort */ }
}
