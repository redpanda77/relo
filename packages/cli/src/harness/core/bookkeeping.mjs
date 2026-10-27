// Hook-owned bookkeeping per session for the local roles (plan 05 §3.3): turnStartedAt, lastStopAt, reminded, restoredAt.
// Separate from the CLI session file, which hooks only ever read.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../shared/atomic-write.mjs";

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
    await writeFileAtomic(path, JSON.stringify(next));
    return true;
  } catch { return false; }
}

// What the status line wrapper last read for a session (relo statusline): context use and cost, plus what was last
// sent to the server. A file of its own: the status line refreshes while hooks write the bookkeeping above.
const contextFile = (directory, session) => join(directory, `context-${String(session).slice(0, 64)}.json`);

export async function readContext(directory, session) {
  try {
    const value = JSON.parse(await readFile(contextFile(directory, session), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

export async function writeContext(directory, session, value) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = contextFile(directory, session);
    await writeFileAtomic(path, JSON.stringify(value));
    return true;
  } catch { return false; }
}
