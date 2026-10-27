// The throttled sweep of local state that outlives its use. Writing a session's file calls it, but it works at most
// once per SWEEP_EVERY_MS (a marker file's mtime, shared by every command), so a burst of commands pays one scan.
// It removes: ended sessions' files (work/state-file.mjs sweep), activity replay fences past FENCE_KEEP_MS and
// sealed-card text caches past SEALED_CARD_KEEP_MS (both only ever read again by a command on the same card or key).
import { mkdir, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { statePath, sweep } from "./state-file.mjs";
import { sealedCardDirectory } from "../crypto/paths.mjs";

export const SWEEP_EVERY_MS = 10 * 60_000;
export const FENCE_KEEP_MS = 30 * 86_400_000;
export const SEALED_CARD_KEEP_MS = 14 * 86_400_000;
const MAX_ENTRIES = 500;

/** Removes files under `directory` (one level of shard folders when `shards`) not modified for `keepMs`. */
async function pruneByAge(directory, keepMs, now, { shards = false } = {}) {
  let names;
  try { names = (await readdir(directory)).slice(0, MAX_ENTRIES); } catch { return; }
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) {
      if (!shards) continue;
      await pruneByAge(path, keepMs, now);
      await rmdir(path).catch(() => {}); // only succeeds once empty
    } else if (now - info.mtimeMs >= keepMs) {
      await rm(path, { force: true }).catch(() => {});
    }
  }
}

/** True (and the marker renewed) when the last sweep is older than `everyMs`. */
export async function sweepDue(dependencies, now, everyMs = SWEEP_EVERY_MS) {
  const marker = statePath(dependencies, "hooks", "sweep.stamp");
  const info = await stat(marker).catch(() => undefined);
  if (info && now - info.mtimeMs >= 0 && now - info.mtimeMs < everyMs) return false;
  try {
    await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
    await writeFile(marker, String(now), { mode: 0o600 });
  } catch { /* unwritable: sweep anyway, as before the marker existed */ }
  return true;
}

/** Sweeps the sessions folder and prunes the old fences and sealed-card caches, if one is due. */
export async function sweepLocalState(dependencies, sessionsDirectory, now = dependencies?.now?.() ?? Date.now()) {
  if (!await sweepDue(dependencies, now)) return false;
  await sweep(sessionsDirectory, now);
  await pruneByAge(statePath(dependencies, "activity-commands"), FENCE_KEEP_MS, now, { shards: true });
  await pruneByAge(sealedCardDirectory(dependencies), SEALED_CARD_KEEP_MS, now);
  return true;
}
