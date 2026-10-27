// Plan-usage bookkeeping from Claude Code's status line: its `rate_limits` (Pro/Max, after the first response) are
// written to a small local file per Claude config folder, which `relo usage` reads. A local reading, not declared or
// observed state: no outbox, no network. Imports only node built-ins and atomic-write: the hook path loads this.
// Claude-only, so it lives with the Claude Code adapter (its `recordUsage`); the core never names Claude.
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../../../shared/atomic-write.mjs";
import descriptor from "./descriptor.mjs";

const REWRITE_AFTER_MS = 60_000;
const WINDOWS = ["five_hour", "seven_day"];

/** The Claude config folder a session ran in: CLAUDE_CONFIG_DIR (trimmed, ~ expanded, resolved) or ~/.claude. */
export function claudeConfigFolder(env, home) {
  const value = env?.[descriptor.config.variable];
  const set = typeof value === "string" ? value.trim() : "";
  if (!set) return resolve(join(home, ".claude"));
  if (set === "~") return resolve(home);
  return resolve(set.startsWith("~/") ? join(home, set.slice(2)) : set);
}

/** A readable slug plus a short stable hash of the folder path: the file name key. */
export function usageKey(folder) {
  const slug = (folder.split(/[\\/]/u).filter(Boolean).pop() ?? "claude").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 24) || "claude";
  return `${slug}-${createHash("sha256").update(folder).digest("hex").slice(0, 8)}`;
}

/** The folder of recorded readings, beside the hook state. */
export const usageDirectory = (stateDirectory) => join(stateDirectory, "usage");
export const claudeUsagePath = (stateDirectory, folder) => join(usageDirectory(stateDirectory), `claude-${usageKey(folder)}.json`);

/** { five_hour?, seven_day? } as { usedPercent, resetsAt (Unix seconds) }, defensively; empty when nothing is valid. */
export function windowsOf(rateLimits) {
  const windows = {};
  if (!rateLimits || typeof rateLimits !== "object" || Array.isArray(rateLimits)) return windows;
  for (const name of WINDOWS) {
    const raw = rateLimits[name];
    const used = Number(raw?.used_percentage);
    const resets = Number(raw?.resets_at);
    if (raw?.used_percentage === null || raw?.resets_at === null || !Number.isFinite(used) || !Number.isFinite(resets) || resets <= 0) continue;
    windows[name] = { usedPercent: Math.min(100, Math.max(0, Math.round(used * 10) / 10)), resetsAt: Math.round(resets) };
  }
  return windows;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Records the status line's rate limits when valid and changed (or older than a minute). Never throws. */
export async function recordClaudeUsage({ input, dependencies }) {
  try {
    const windows = windowsOf(input?.rate_limits);
    if (Object.keys(windows).length === 0) return;
    const home = dependencies.home;
    const stateDirectory = join(dependencies.hookStateDirectory, "..");
    const folder = claudeConfigFolder(dependencies.env, home);
    const path = claudeUsagePath(stateDirectory, folder);
    const now = dependencies.now();
    let before;
    try { before = JSON.parse(await readFile(path, "utf8")); } catch { before = undefined; }
    if (before && same(before.windows, windows) && before.configDir === folder && now - before.readAt < REWRITE_AFTER_MS && now >= before.readAt) return;
    await mkdir(usageDirectory(stateDirectory), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, JSON.stringify({ configDir: folder, readAt: now, windows }));
  } catch { /* the status line never fails for a reading */ }
}
