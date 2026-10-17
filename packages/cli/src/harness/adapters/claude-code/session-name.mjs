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
import { dirname, isAbsolute, join } from "node:path";
import { hasAbsolutePath, looksLikeToken } from "../../../work/content-filter.mjs";

export const SESSION_NAME_MAX = 80;
/** CLAUDE_CODE_ENTRYPOINT under the Claude desktop app: its sidebar title names the session (desktop-title.mjs). */
export const DESKTOP_ENTRYPOINT = "claude-desktop";
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

// ---- Claude Desktop sidebar titles (kept here: hooks load as few modules as possible) ----
// Desktop keeps its own session metadata, one file per session, at
//   <Application Support>/Claude/claude-code-sessions/<account>/<org>/local_*.json   { cliSessionId, title, cwd, … }
// Read locally, read-only, bounded; a missing folder or malformed file is skipped. Titles are cleaned like Relo's own.


export const DESKTOP_SCAN_MAX = 2_000;
const DESKTOP_FILE_MAX = 256 * 1024;

/** Where Desktop keeps its session files on this computer (macOS, then Linux), as absolute folders. */
export const desktopSessionRoots = (home = homedir()) => [
  join(home, "Library", "Application Support", "Claude", "claude-code-sessions"),
  join(home, ".config", "Claude", "claude-code-sessions"),
];

const dirEntries = (directory) => { try { return readdirSync(directory, { withFileTypes: true }); } catch { return []; } };

/** The parsed JSON of a small file, or undefined. */
function readJsonFile(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size > DESKTOP_FILE_MAX) return undefined;
    const buffer = Buffer.alloc(size);
    const read = readSync(fd, buffer, 0, size, 0);
    return JSON.parse(buffer.subarray(0, read).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
  }
}

/**
 * The Desktop sessions on this computer: Map of Claude session id → { title (cleaned), cwd? }. At most `limit`
 * files are opened (account/org folders are walked, local_*.json files read); never throws.
 */
export function desktopSessions({ home = homedir(), limit = DESKTOP_SCAN_MAX } = {}) {
  const found = new Map();
  let opened = 0;
  try {
    for (const root of desktopSessionRoots(home)) {
      for (const account of dirEntries(root).filter((entry) => entry.isDirectory())) {
        for (const org of dirEntries(join(root, account.name)).filter((entry) => entry.isDirectory())) {
          for (const file of dirEntries(join(root, account.name, org.name))) {
            if (!file.isFile() || !file.name.startsWith("local_") || !file.name.endsWith(".json")) continue;
            if (opened >= limit) return found;
            opened += 1;
            const data = readJsonFile(join(root, account.name, org.name, file.name));
            const id = data?.cliSessionId;
            const title = cleanSessionName(data?.title);
            if (typeof id !== "string" || !SESSION_ID.test(id) || !title) continue;
            found.set(id, { title, path: join(root, account.name, org.name, file.name), ...(typeof data.cwd === "string" ? { cwd: data.cwd } : {}) });
          }
        }
      }
    }
  } catch { /* what was read stands */ }
  return found;
}

/** The sidebar title Desktop shows for Claude session `sessionId`, or undefined (no Desktop, no file, no title). */
export function findDesktopTitle({ sessionId, home = homedir(), limit = DESKTOP_SCAN_MAX } = {}) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return undefined;
  return desktopSessions({ home, limit }).get(sessionId)?.title;
}

/**
 * The sidebar title of `sessionId`: one read of the file at `cachedPath` when it still belongs to the session, else
 * (unless `skipScan`) one scan. { title?, path?, scanned }; never throws.
 */
export function desktopTitleFor({ sessionId, home = homedir(), cachedPath, skipScan = false } = {}) {
  try {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return { scanned: false };
    if (typeof cachedPath === "string" && isAbsolute(cachedPath) && cachedPath.endsWith(".json")) {
      const data = readJsonFile(cachedPath);
      if (data?.cliSessionId === sessionId) {
        const title = cleanSessionName(data.title);
        if (title) return { title, path: cachedPath, scanned: false };
      }
    }
    if (skipScan) return { scanned: false };
    const found = desktopSessions({ home }).get(sessionId);
    return found ? { title: found.title, path: found.path, scanned: true } : { scanned: true };
  } catch {
    return { scanned: false };
  }
}

// ---- One session-title rule (hooks and relo commands both come through the adapter's resolveTitle) ----

/** How long a "Desktop has no file for this session" answer is trusted before the scan runs again. */
export const TITLE_MISS_MS = 10 * 60 * 1000;

/**
 * The session's name and what to remember for next time. Under Claude Desktop (CLAUDE_CODE_ENTRYPOINT) the sidebar
 * title wins; otherwise, or when Desktop has nothing, today's sources (title file, transcript). `titlePath` is the
 * Desktop file found earlier and `titleMissAt` (ms) when a scan last found none; the returned `cache` replaces both
 * (local state only, never sent). Synchronous, bounded, never throws.
 */
export function claudeResolveTitle({ sessionId, env = process.env, home = homedir(), cwd = process.cwd(), titlePath, titleMissAt, now = Date.now() } = {}) {
  const cache = {};
  try {
    if (env?.CLAUDE_CODE_ENTRYPOINT === DESKTOP_ENTRYPOINT) {
      const missed = !titlePath && Number.isFinite(titleMissAt) && now - titleMissAt >= 0 && now - titleMissAt < TITLE_MISS_MS;
      const desktop = desktopTitleFor({ sessionId, home, cachedPath: titlePath, skipScan: missed });
      if (desktop.title) return { title: desktop.title, cache: { titlePath: desktop.path } };
      cache.titleMissAt = desktop.scanned || !missed ? now : titleMissAt;
    }
  } catch { /* today's sources stand */ }
  return { title: claudeSessionName({ sessionId, env, home, cwd }), cache };
}

// ---- Context size (kept in this module: hooks load as few modules as possible, see startup-budget.test.mjs) ----
// The context a Claude Code session has in use, read from the tail of its transcript (the hook payload's
// transcript_path). The desktop app never runs a status line, but it runs hooks. Only token counts leave this
// function: no message text is kept. Bounded read (256 KB tail), synchronous, never throws.

export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
export const CONTEXT_TOKENS_MAX = 10_000_000;

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

/**
 * Tokens in use after the last main-chain assistant message in a transcript tail: input + cache creation + cache
 * read of its usage. Sidechain (subagent) lines, a first line cut by the tail, and unparseable lines are skipped.
 * undefined when the tail holds no such message.
 */
export function contextTokensOfTail({ text, partial = false }) {
  const lines = String(text).split("\n");
  if (partial) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"usage"')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.isSidechain === true || record?.type === "user") continue;
    const message = record?.message;
    const usage = message?.usage;
    if (!usage || typeof usage !== "object" || (message.role !== undefined && message.role !== "assistant")) continue;
    // Claude Code's synthetic messages (an interrupted or failed turn) report no real usage.
    if (message.model === "<synthetic>") continue;
    const tokens = count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens);
    if (tokens > 0) return Math.min(CONTEXT_TOKENS_MAX, tokens);
  }
  return undefined;
}

/** The context tokens of the transcript at `path` (an absolute .jsonl path from the hook payload), or undefined. */
export function claudeContextTokens(path) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl")) return undefined;
    const tail = readBounded(path, TRANSCRIPT_TAIL_BYTES, { tail: true });
    return tail ? contextTokensOfTail(tail) : undefined;
  } catch {
    return undefined;
  }
}
