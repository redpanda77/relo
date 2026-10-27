// Atomic private JSON files (plan 04 §2.7). The caller's module picks the root; nothing here takes a key
// from the command line.
import { constants } from "node:fs";
import { open, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/atomic-write.mjs";
import { ensurePrivateDirectory } from "../shared/private-dir.mjs";
import { FACTS } from "../shared/facts.generated.mjs";

/** The owner-state windows (contracts OWNER_STATE_TIMING, through the generated facts). */
export const T_FRESH_MS = FACTS.card.freshSeconds * 1000;
export const T_RETIRE_MS = FACTS.card.retireSeconds * 1000;
export const T_HISTORY_MS = FACTS.card.maxSeconds * 1000;
const MAX_BYTES = 256 * 1024;

/**
 * The CLI's data folder (plan 10 D2): what outlives a state reset, such as verified releases and archived skill
 * copies. One home for its path; docs/site/reference/files.md lists what is in it (state-paths.test.mjs).
 */
export function dataRoot(home, env = home === undefined ? process.env : {}, platform = process.platform) {
  home ??= homedir();
  return platform === "win32" ? join(localAppData(env, home), "Relo", "data") : join(home, ".local", "share", "relo");
}

/** %LOCALAPPDATA% (the env's own, so an injected home never reaches the real one), else <home>\AppData\Local. */
const localAppData = (env, home) => env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");

/**
 * The CLI's state folder: the env's RELO_STATE_DIR, then its XDG_STATE_HOME, then the process's RELO_STATE_DIR
 * (a test's own env object without either never falls back to the real folder), then ~/.local/state/relo (win32: %LOCALAPPDATA%\Relo\state; the data folder is ...\Relo\data).
 */
export function stateRoot(env = process.env, home = homedir(), platform = process.platform) {
  return env.RELO_STATE_DIR?.trim() || (env.XDG_STATE_HOME?.trim() && join(env.XDG_STATE_HOME.trim(), "relo"))
    || process.env.RELO_STATE_DIR?.trim()
    || (platform === "win32" ? join(localAppData(env, home), "Relo", "state") : join(home, ".local", "state", "relo"));
}

/**
 * A path in the state folder for a command's place ({ env, home }: its dependencies). Every module that keeps
 * local state derives its path here, so RELO_STATE_DIR moves all of it and an injected home is never left.
 */
export function statePath(place = {}, ...parts) {
  const env = place.env ?? process.env;
  return join(stateRoot(env, place.home ?? (env.HOME?.trim() || homedir())), ...parts);
}

export async function readStateFile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return undefined;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return undefined;
    const data = JSON.parse(await handle.readFile("utf8"));
    return data?.v === 1 ? data : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Writes atomically; skipped when the file already holds a newer version of the same open work. */
export async function writeStateFile(path, data, { privateDirectory = {} } = {}) {
  const dir = join(path, "..");
  // On Windows the first write under %LOCALAPPDATA%\Relo restricts that folder to this user (once; a marker file remembers).
  await ensurePrivateDirectory(dir, privateDirectory);
  const existing = await readStateFile(path);
  if (existing?.open && data.open && existing.open.id === data.open.id && (existing.open.version ?? 0) > (data.open.version ?? 0)) return false;
  await writeFileAtomic(path, JSON.stringify({ ...data, v: 1, writtenAt: new Date().toISOString() }));
  return true;
}

export async function sweep(dir, now = Date.now()) {
  try {
    const names = (await readdir(dir)).slice(0, 500);
    for (const name of names) {
      const path = join(dir, name);
      const info = await stat(path).catch(() => undefined);
      if (info && now - info.mtimeMs >= T_HISTORY_MS) await rm(path, { force: true }).catch(() => {});
    }
  } catch { /* nothing to sweep */ }
}
