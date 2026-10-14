// The calling Claude Code session's human name (plan 3.7, decision D5: sessions are named by Claude,
// never by the agent). Read locally, read-only, keyed by the harness session id; only the cleaned name
// leaves this module, and only when it is safe to show on the Lock Screen.
//
// Where Claude Code keeps it, under <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<sanitized cwd>/:
//  - <session id>/custom-title.json   {"customTitle":"…"}: the current title (set by the owner, or the
//    one Claude generated; the Claude desktop app mirrors its session title here).
//  - <session id>.jsonl               transcript; {"type":"custom-title","customTitle":"…"} records
//    (repeated every turn), older {"type":"summary","summary":"…"} and {"type":"ai-title",…} records.
// The Claude desktop app's own metadata (Application Support/Claude/claude-code-sessions/…/local_*.json,
// {cliSessionId, title, titleSource}) is not read: finding the file means scanning every session.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hasAbsolutePath, looksLikeToken } from "../work/content-filter.mjs";

export const SESSION_NAME_MAX = 80;
const TITLE_FILE_MAX = 4 * 1024;
const TAIL_BYTES = 256 * 1024;
const MAX_PROJECT_DIRS = 2_000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** Claude Code's project directory name for a working directory: every non-alphanumeric is "-". */
const projectDirName = (path) => path.replace(/[^A-Za-z0-9]/gu, "-");

/** Bytes of `path` from `start` (negative: from the end), at most `max`; undefined when unreadable. */
function readBounded(path, max, { tail = false } = {}) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, tail ? size - length : 0);
    return { text: buffer.subarray(0, read).toString("utf8"), partial: size > length };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** The project directory holding this session: the working directory and its parents first, then a bounded scan. */
function sessionDirectory(projects, sessionId, cwd) {
  const has = (dir) => existsSync(join(dir, `${sessionId}.jsonl`)) || existsSync(join(dir, sessionId));
  for (let dir = cwd; dir; dir = dirname(dir)) {
    const candidate = join(projects, projectDirName(dir));
    if (has(candidate)) return candidate;
    if (dirname(dir) === dir) break;
  }
  const entries = readdirSync(projects).slice(0, MAX_PROJECT_DIRS);
  for (const entry of entries) {
    const candidate = join(projects, entry);
    if (has(candidate)) return candidate;
  }
  return undefined;
}

/** One line of real words, at most SESSION_NAME_MAX characters, never a path or a secret; else undefined. */
export function cleanSessionName(value) {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  let text = value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!/\p{L}{2,}/u.test(text) || hasAbsolutePath(text) || looksLikeToken(text)) return undefined;
  const chars = Array.from(text);
  if (chars.length > SESSION_NAME_MAX) text = `${chars.slice(0, SESSION_NAME_MAX - 1).join("").trimEnd()}…`;
  return text;
}

/** The last title records in a transcript tail: an explicit title first, then Claude's generated title or summary. */
function transcriptName(path) {
  const tail = readBounded(path, TAIL_BYTES, { tail: true });
  if (!tail) return undefined;
  const lines = tail.text.split("\n");
  if (tail.partial) lines.shift(); // the first line was cut by the tail
  const found = {};
  for (const line of lines) {
    if (!line.includes('"type":"custom-title"') && !line.includes('"type":"ai-title"') && !line.includes('"type":"summary"')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type === "custom-title") found.custom = record.customTitle ?? found.custom;
    else if (record?.type === "ai-title") found.ai = record.aiTitle ?? record.title ?? found.ai;
    else if (record?.type === "summary") found.summary = record.summary ?? found.summary;
  }
  return cleanSessionName(found.custom) ?? cleanSessionName(found.ai) ?? cleanSessionName(found.summary);
}

/**
 * The human name of Claude Code session `sessionId`, or undefined. Bounded reads (4 KB title file,
 * 256 KB transcript tail), synchronous, never throws.
 */
export function claudeSessionName({ sessionId, env = process.env, home = homedir(), cwd = process.cwd() } = {}) {
  try {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return undefined;
    const root = typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR.trim() : join(home, ".claude");
    const directory = sessionDirectory(join(root, "projects"), sessionId, cwd);
    if (!directory) return undefined;
    const titleFile = readBounded(join(directory, sessionId, "custom-title.json"), TITLE_FILE_MAX);
    if (titleFile && !titleFile.partial) {
      try {
        const title = cleanSessionName(JSON.parse(titleFile.text)?.customTitle);
        if (title) return title;
      } catch { /* fall through to the transcript */ }
    }
    return transcriptName(join(directory, `${sessionId}.jsonl`));
  } catch {
    return undefined;
  }
}

/** The calling agent session's name, for the harnesses whose names Relo can read; undefined otherwise. */
export function sessionName(dependencies) {
  const caller = dependencies?.caller;
  if (caller?.type !== "agent_session" || caller.harness !== "claude-code") return undefined;
  return claudeSessionName({ sessionId: caller.sessionId, env: dependencies.env, home: dependencies.home, cwd: dependencies.cwd });
}
