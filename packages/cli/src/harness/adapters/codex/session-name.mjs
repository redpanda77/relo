// The calling Codex thread's human name, read locally and read-only. Codex appends one JSON line per thread
// naming to <CODEX_HOME or ~/.codex>/session_index.jsonl: {"id":"<thread id>","thread_name":"…","updated_at":"…"}.
// The id is the thread id hooks receive as session_id (CODEX_THREAD_ID); a renamed thread has more than one line and
// the last one wins. Only the cleaned name leaves this module (a path or a secret is never a name).
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanSessionName } from "../claude-code/session-name.mjs";

/** The index of a long-used Codex is a few hundred KB; past this only its newest lines are read. */
const INDEX_TAIL_BYTES = 8 * 1024 * 1024;
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export function codexSessionName({ sessionId, env = process.env, home = homedir() } = {}) {
  if (typeof sessionId !== "string" || !THREAD_ID.test(sessionId)) return undefined;
  const directory = typeof env?.CODEX_HOME === "string" && env.CODEX_HOME ? env.CODEX_HOME : join(home, ".codex");
  let text;
  let partial;
  let fd;
  try {
    fd = openSync(join(directory, "session_index.jsonl"), "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, INDEX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    text = buffer.subarray(0, read).toString("utf8");
    partial = size > length;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
  }
  const lines = text.split("\n");
  if (partial) lines.shift(); // the first line of a tail read is cut
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes(sessionId)) continue;
    try {
      const record = JSON.parse(line);
      if (record?.id === sessionId) {
        const name = cleanSessionName(record.thread_name);
        if (name) return name;
      }
    } catch { /* a partial or foreign line */ }
  }
  return undefined;
}
