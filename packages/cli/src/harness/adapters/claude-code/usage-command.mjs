// Claude Code's own `/usage` (print mode) as a second source of plan limits for `relo usage`, for people whose
// Claude never runs the status line (the desktop app's Code tab). Claude-only, so it lives with the Claude Code
// adapter: the binary name and the config variable come from the descriptor. A local reading, not Relo state.
import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { writeFileAtomic } from "../../../shared/atomic-write.mjs";
import descriptor from "./descriptor.mjs";
import { claudeUsagePath, usageDirectory } from "./usage-record.mjs";

export const FRESH_MS = 5 * 60_000;
const TIMEOUT_MS = 20_000;
const MAX_AHEAD_MS = 8 * 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Milliseconds the zone is ahead of UTC at this instant; undefined for an unknown zone. */
export function zoneOffsetMs(instant, zone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000;
  } catch { return undefined; }
}

/** Unix seconds of a wall-clock time in an IANA zone, or undefined. */
export function zonedSeconds(year, month, day, hour, minute, zone) {
  const wall = Date.UTC(year, month, day, hour, minute);
  const first = zoneOffsetMs(wall, zone);
  if (first === undefined) return undefined;
  const second = zoneOffsetMs(wall - first, zone) ?? first;
  return Math.floor((wall - second) / 1000);
}

/** "Oct 27 at 9:10pm (Asia/Dubai)" -> Unix seconds in the next ~8 days after `now` (ms), or undefined. */
export function parseReset(textValue, now) {
  const match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*,?\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*\(([^)]+)\)/iu.exec(String(textValue ?? "").trim());
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase());
  const day = Number(match[2]);
  const hour12 = Number(match[3]);
  const minute = match[4] === undefined ? 0 : Number(match[4]);
  if (month < 0 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + (match[5].toLowerCase() === "p" ? 12 : 0);
  const year = new Date(now).getUTCFullYear();
  for (const candidate of [year - 1, year, year + 1]) {
    const seconds = zonedSeconds(candidate, month, day, hour, minute, match[6].trim());
    if (seconds === undefined) return undefined;
    if (seconds * 1000 > now - 60_000 && seconds * 1000 <= now + MAX_AHEAD_MS) return seconds;
  }
  return undefined;
}

const LINES = [["five_hour", /^Current session\b/iu], ["seven_day", /^Current week \(all models\)/iu]];

/** { five_hour?, seven_day? } as { usedPercent, resetsAt }, from `/usage` output. Defensive: an odd line is skipped. */
export function parseUsage(output, now) {
  const windows = {};
  for (const line of String(output ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    for (const [kind, pattern] of LINES) {
      if (windows[kind] || !pattern.test(trimmed)) continue;
      const used = /:\s*(\d+(?:\.\d+)?)%\s*used/iu.exec(trimmed);
      const reset = /resets?\s+(.*)$/iu.exec(trimmed);
      const resetsAt = reset ? parseReset(reset[1], now) : undefined;
      if (!used || resetsAt === undefined) continue;
      windows[kind] = { usedPercent: Math.min(100, Math.max(0, Number(used[1]))), resetsAt };
    }
  }
  return windows;
}

const isFile = (path) => stat(path).then((info) => info.isFile(), () => false);

/** The Claude binary on PATH (or the usual user-level folders), or undefined. */
export async function findBinary({ env, home }) {
  const win = process.platform === "win32";
  const folders = String(env?.PATH ?? env?.Path ?? "").split(win ? ";" : delimiter).filter(Boolean);
  folders.push(join(home, ".local", "bin"), join(home, ".claude", "local"));
  for (const folder of folders) for (const suffix of win ? [".exe", ".cmd", ""] : [""]) {
    const path = join(folder, `${descriptor.installation.binaries[0]}${suffix}`);
    if (await isFile(path)) return path;
  }
  return undefined;
}

// A run inside a Claude Code session would inherit that session's markers and answer with its cost summary, not /usage.
// The variable is set only for a non-default profile: pointing it at ~/.claude makes Claude create a second .claude.json there.
const childEnv = (env, folder, home) => {
  const kept = Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !/^CLAUDECODE$|^CLAUDE_CODE_/u.test(name) && name !== descriptor.config.variable));
  return folder === resolve(join(home, descriptor.config.home)) ? kept : { ...kept, [descriptor.config.variable]: folder };
};

/** Runs `claude --print /usage` once: stdout, or undefined on failure or timeout (the process is killed). */
export function runUsage({ binary, env, folder, home, cwd, timeoutMs = TIMEOUT_MS }) {
  return new Promise((done) => {
    try {
      const child = execFile(binary, ["--print", "--no-session-persistence", "--strict-mcp-config", "/usage"], {
        cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1_000_000, windowsHide: true,
        env: childEnv(env, folder, home),
      }, (error, stdout) => done(error ? undefined : String(stdout)));
      child.stdin?.end();
    } catch { done(undefined); }
  });
}

const cachePath = (stateDirectory, folder) => claudeUsagePath(stateDirectory, folder).replace(/claude-([^/\\]+)$/u, "claude-usage-$1");

/**
 * The windows from Claude's `/usage` for one config folder, or undefined. A cached reading younger than 5 minutes is
 * used as is; otherwise `/usage` runs at most once per 5 minutes per folder (a failure is cached too). Never throws.
 * `run({ binary, env, folder, cwd })` is injectable; `now` is ms.
 */
export async function claudeUsageWindows({ folder, env, home, stateDirectory, now, run = runUsage }) {
  try {
    const path = cachePath(stateDirectory, folder);
    let cached;
    try { cached = JSON.parse(await readFile(path, "utf8")); } catch { cached = undefined; }
    const tried = Number.isFinite(cached?.attemptedAt) ? cached.attemptedAt : -Infinity;
    if (now - tried >= FRESH_MS || tried > now) {
      const binary = await findBinary({ env, home });
      if (!binary) return usable(cached, now);
      const output = await run({ binary, env: env ?? {}, folder, home, cwd: stateDirectory });
      const windows = parseUsage(output, now);
      const next = Object.keys(windows).length > 0
        ? { attemptedAt: now, readAt: now, windows }
        : { attemptedAt: now, readAt: cached?.readAt ?? null, windows: cached?.windows ?? {} };
      try {
        await mkdir(usageDirectory(stateDirectory), { recursive: true, mode: 0o700 });
        await writeFileAtomic(path, JSON.stringify(next));
      } catch { /* the reading still counts */ }
      return usable(next, now);
    }
    return usable(cached, now);
  } catch { return undefined; }
}

function usable(cached, now) {
  if (!Number.isFinite(cached?.readAt) || now - cached.readAt >= FRESH_MS || cached.readAt > now) return undefined;
  return { readAt: cached.readAt, windows: cached.windows ?? {} };
}
