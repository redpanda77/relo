// Atomic file writes: a unique temp file beside the target, then a rename. On Windows a rename onto a file another
// process has open fails with EPERM/EBUSY/EACCES (hooks run concurrently), so it retries a few times with a short
// backoff. Elsewhere those codes are real permission errors and surface at once. Imports only node built-ins: the
// hook path loads this.
import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const TRIES = 8;
const BACKOFF_MS = [10, 20, 40, 80];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** rename(), retried on win32 while another process holds either path; { platform, rename, sleep, tries } are injectable. */
export async function renameWithRetry(from, to, options = {}) {
  const { platform = process.platform, rename: move = rename, sleep = pause, tries = TRIES } = options;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await move(from, to);
    } catch (error) {
      if (platform !== "win32" || !RETRY_CODES.has(error?.code) || attempt >= tries) throw error;
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1]);
    }
  }
}

/**
 * Writes `data` to `path` atomically: an exclusive temp file in the same folder (`mode`, default 0o600; fsynced
 * when `sync`), then renamed over `path`. The temp file is removed if the write or rename fails. Options also
 * take the renameWithRetry ones.
 */
export async function writeFileAtomic(path, data, options = {}) {
  const { mode = 0o600, sync = false, ...retry } = options;
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temp, "wx", mode);
    try {
      await handle.writeFile(data);
      if (sync) await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, path, retry);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
