// Hook-owned bookkeeping per session for the local roles (plan 05 §3.3): turnStartedAt, lastStopAt, reminded, restoredAt.
// Separate from the CLI session file, which hooks only ever read.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const fileFor = (directory, session) => join(directory, `harness-${String(session).slice(0, 64)}.json`);

export async function readBookkeeping(directory, session) {
  try {
    const value = JSON.parse(await readFile(fileFor(directory, session), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export async function writeBookkeeping(directory, session, patch) {
  try {
    const next = { ...(await readBookkeeping(directory, session)), ...patch };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = fileFor(directory, session);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
    await rename(temp, path);
    return true;
  } catch { return false; }
}
