// Claude accounts for `relo usage`: the config folders on this computer (~/.claude, $CLAUDE_CONFIG_DIR, ~/.claude-<slug>
// profiles), each one's account email and plan from its .claude.json, whether Relo's status line is installed there,
// and the plan limits that status line last recorded (harness/adapters/claude-code/usage-record.mjs). All local reads; no secrets kept.
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isReloStatusline } from "../../harness/core/launch.mjs";
import { claudeConfigFolder, claudeUsagePath } from "../../harness/adapters/claude-code/usage-record.mjs";
import descriptor from "../../harness/adapters/claude-code/descriptor.mjs";
import { FRESH_MS, claudeUsageWindows } from "../../harness/adapters/claude-code/usage-command.mjs";
import { displayName } from "../../shared/usage-cache.mjs";

const exists = (path) => stat(path).then(() => true, () => false);
const readJson = async (path) => { try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; } };
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** "default_claude_max_5x" -> "Max 5x"; falls back to the organization type ("claude_max" -> "Max"). */
export function planLabel(account) {
  const tier = text(account?.userRateLimitTier) ?? text(account?.organizationRateLimitTier);
  const fromTier = /(?:claude_)?(max|pro|team|enterprise|free)(?:_(\d+x))?$/iu.exec(tier ?? "");
  if (fromTier) return [fromTier[1][0].toUpperCase() + fromTier[1].slice(1).toLowerCase(), fromTier[2]].filter(Boolean).join(" ");
  const type = text(account?.organizationType)?.replace(/^claude_?/iu, "").replace(/_/gu, " ");
  return type ? type[0].toUpperCase() + type.slice(1) : null;
}

/** The Claude folders to list: [{ id, profile, folder }]. */
export async function claudeFolders({ env, home }) {
  const standard = resolve(join(home, ".claude"));
  const folders = new Map();
  const add = (folder) => folders.set(folder, folder);
  if (await exists(standard) || await exists(join(home, ".claude.json"))) add(standard);
  const active = claudeConfigFolder(env, home);
  if (active !== standard && await exists(active)) add(active);
  let names = [];
  try { names = await readdir(home); } catch { /* no home to read */ }
  for (const name of names.filter((entry) => entry.startsWith(".claude-")).sort()) {
    const folder = join(home, name);
    const real = (await stat(folder).catch(() => undefined))?.isDirectory() === true
      && (await exists(join(folder, ".claude.json")) || await exists(join(folder, "settings.json")) || await exists(join(folder, "projects")));
    if (real) add(folder);
  }
  return [...folders.keys()].map((folder) => {
    const slug = folder === standard ? null : basename(folder).replace(/^\.claude-?/u, "").replace(/^\./u, "") || basename(folder);
    return { id: slug ? `claude-${slug}` : "claude", profile: slug, folder };
  });
}

const MINUTES = { five_hour: 300, seven_day: 10_080 };
const LABELS = { five_hour: "5-hour", seven_day: "Week" };
const liveWindows = (raw, now) => Object.keys(MINUTES).flatMap((kind) => {
  const window = raw?.[kind];
  if (!Number.isFinite(window?.usedPercent) || !Number.isFinite(window?.resetsAt) || window.resetsAt * 1000 <= now) return [];
  return [{ kind, minutes: MINUTES[kind], label: LABELS[kind], usedPercent: window.usedPercent, resetsAt: window.resetsAt }];
});

/** One account row. `stateDirectory`: the CLI's state folder; `now`: ms; `env`, `run`: for Claude's own /usage (run is injectable). */
export async function claudeAccount({ id, profile, folder }, { home, stateDirectory, now, env, run }) {
  const standard = resolve(join(home, ".claude"));
  const own = await readJson(join(folder, ".claude.json"));
  const account = own?.oauthAccount ?? (folder === standard ? (await readJson(join(home, ".claude.json")))?.oauthAccount : undefined);
  const settings = await readJson(join(folder, "settings.json"));
  const command = settings?.statusLine?.command;
  const connected = typeof command === "string" && isReloStatusline(command.trim());
  const recorded = await readJson(claudeUsagePath(stateDirectory, folder));
  let windows = liveWindows(recorded?.windows, now);
  let source = windows.length > 0 ? "status-line" : null;
  let readAt = Number.isFinite(recorded?.readAt) ? recorded.readAt : null;
  const fresh = windows.length > 0 && readAt !== null && now - readAt < FRESH_MS && readAt <= now;
  if (!fresh) {
    const reading = await claudeUsageWindows({ folder, env, home, stateDirectory, now, ...(run ? { run } : {}) });
    const own = liveWindows(reading?.windows, now);
    if (own.length > 0) { windows = own; source = "claude-usage"; readAt = reading.readAt; }
  }
  return {
    id, plan: "claude", displayName: displayName("Claude", profile), profile, configDir: folder, email: text(account?.emailAddress), planName: planLabel(account),
    connected,
    hint: connected ? null : `${folder === standard ? "" : `${descriptor.config.variable}=${folder} `}relo setup --level optimize --statusline on`,
    readAt, source,
    windows,
  };
}
