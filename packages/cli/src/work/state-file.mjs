// Atomic private JSON files (plan 04 §2.7). The caller's module picks the root; nothing here takes a key
// from the command line.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const T_RETIRE_MS = 3600_000;
export const T_HISTORY_MS = 28_800_000;
const MAX_BYTES = 256 * 1024;

/**
 * The CLI's state folder: the env's RELO_STATE_DIR, then its XDG_STATE_HOME, then the process's RELO_STATE_DIR
 * (a test's own env object without either never falls back to the real folder), then ~/.local/state/relo.
 */
export function stateRoot(env = process.env, home = homedir()) {
  return env.RELO_STATE_DIR?.trim() || (env.XDG_STATE_HOME?.trim() && join(env.XDG_STATE_HOME.trim(), "relo"))
    || process.env.RELO_STATE_DIR?.trim() || join(home, ".local", "state", "relo");
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
export async function writeStateFile(path, data) {
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = await readStateFile(path);
  if (existing?.open && data.open && existing.open.id === data.open.id && (existing.open.version ?? 0) > (data.open.version ?? 0)) return false;
  const temp = join(dir, `.${path.split("/").pop()}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temp, JSON.stringify({ ...data, v: 1, writtenAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temp, path);
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
