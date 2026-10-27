// Codex accounts for `relo usage`: ~/.codex (or $CODEX_HOME) and every ~/.codex-<slug> with an auth.json. The email is
// the id token's payload (decoded, never verified, never kept); the limits are the last `rate_limits` event in the
// newest session rollout, or else the account endpoint (adapters/codex/usage-endpoint.mjs, cached). Tokens are never
// printed or stored.
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import * as zlib from "node:zlib";
import descriptor from "../../harness/adapters/codex/descriptor.mjs";
import { codexEndpointReading } from "../../harness/adapters/codex/usage-endpoint.mjs";
import { displayName, folderKey, windowLabel } from "../../shared/usage-cache.mjs";

const MAX_FILES = 20;
const TAIL_BYTES = 1_000_000;
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const exists = (path) => stat(path).then(() => true, () => false);
const listing = (path) => readdir(path).catch(() => []);

/** The Codex homes to list: [{ id, profile, folder }]. */
export async function codexFolders({ env, home }) {
  const standard = resolve(join(home, ".codex"));
  const folders = new Set();
  const set = env?.[descriptor.config.variable]?.trim();
  const moved = set ? resolve(set) : undefined;
  for (const folder of [moved ?? standard, standard]) if (await exists(join(folder, "auth.json"))) folders.add(folder);
  for (const name of (await listing(home)).filter((entry) => entry.startsWith(".codex-")).sort()) {
    if (await exists(join(home, name, "auth.json"))) folders.add(join(home, name));
  }
  return [...folders].map((folder) => {
    const slug = folder === standard ? null : basename(folder).replace(/^\.codex-?/u, "") || basename(folder);
    return { id: slug ? `codex-${slug}` : "codex", profile: slug, folder };
  });
}

/** The email in an id_token's payload (base64url JSON), or null. */
export function emailOfIdToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return text(payload?.email) ?? text(payload?.["https://api.openai.com/profile"]?.email);
  } catch { return null; }
}

/** Rollout files, newest first: sessions/YYYY/MM/DD/rollout-*.jsonl(.zst), at most `limit`. */
async function newestRollouts(sessions, limit) {
  const found = [];
  const numbered = async (path) => (await listing(path)).filter((name) => /^\d+$/u.test(name)).sort().reverse();
  for (const year of await numbered(sessions)) {
    for (const month of await numbered(join(sessions, year))) {
      for (const day of await numbered(join(sessions, year, month))) {
        const folder = join(sessions, year, month, day);
        const files = (await listing(folder)).filter((name) => /^rollout-.*\.jsonl(\.zst)?$/u.test(name));
        const dated = await Promise.all(files.map(async (name) => ({ path: join(folder, name), at: (await stat(join(folder, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
        found.push(...dated.sort((a, b) => b.at - a.at));
        if (found.length >= limit) return found.slice(0, limit);
      }
    }
  }
  return found;
}

/** The text of a rollout (a huge plain file: its tail only); undefined when unreadable or zstd is unavailable. */
async function rolloutText(path) {
  try {
    if (path.endsWith(".zst")) return typeof zlib.zstdDecompressSync === "function" ? zlib.zstdDecompressSync(await readFile(path)).toString("utf8") : undefined;
    const size = (await stat(path)).size;
    if (size <= TAIL_BYTES) return await readFile(path, "utf8");
    const { open } = await import("node:fs/promises");
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(TAIL_BYTES);
      await handle.read(buffer, 0, TAIL_BYTES, size - TAIL_BYTES);
      return buffer.toString("utf8");
    } finally { await handle.close(); }
  } catch { return undefined; }
}

/** The last rate_limits object in a rollout's text: { primary, secondary, plan_type }, or undefined. */
export function lastRateLimits(content) {
  const lines = String(content ?? "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes('"rate_limits"')) continue;
    try {
      const found = (function search(value, depth) {
        if (!value || typeof value !== "object" || depth > 6) return undefined;
        if (value.rate_limits && typeof value.rate_limits === "object") return value.rate_limits;
        for (const child of Object.values(value)) { const hit = search(child, depth + 1); if (hit) return hit; }
        return undefined;
      })(JSON.parse(lines[index]), 0);
      if (found) return found;
    } catch { /* a cut line */ }
  }
  return undefined;
}

/** One account row. `stateDirectory`: the CLI's state folder; `now`: ms; `fetcher`: the endpoint's HTTP reader (injectable). */
export async function codexAccount({ id, profile, folder }, { now, stateDirectory, fetcher }) {
  let auth;
  try { auth = JSON.parse(await readFile(join(folder, "auth.json"), "utf8")); } catch { auth = undefined; }
  const email = emailOfIdToken(auth?.tokens?.id_token);
  let limits;
  let readAt = null;
  let unavailable = false;
  for (const file of await newestRollouts(join(folder, "sessions"), MAX_FILES)) {
    const content = await rolloutText(file.path);
    if (content === undefined) { unavailable = unavailable || file.path.endsWith(".zst"); continue; }
    limits = lastRateLimits(content);
    if (limits) { readAt = Math.round(file.at); break; }
  }
  let windows = [];
  for (const kind of ["primary", "secondary"]) {
    const window = limits?.[kind];
    const resets = Number(window?.resets_at);
    if (!Number.isFinite(Number(window?.used_percent)) || !Number.isFinite(resets) || resets * 1000 <= now) continue;
    const minutes = Number.isFinite(Number(window.window_minutes)) ? Number(window.window_minutes) : null;
    windows.push({ kind, minutes, label: windowLabel(minutes), usedPercent: Number(window.used_percent), resetsAt: resets });
  }
  let source = windows.length > 0 ? "rollout" : null;
  let planName = text(limits?.plan_type) ?? text(auth?.tokens?.plan_type);
  let hint = !limits && unavailable ? "Compressed Codex sessions need a Node with zstd support to read." : null;
  if (windows.length === 0 && auth !== undefined) {
    const reading = await codexEndpointReading({ folder, folderKey: folderKey(folder), auth, stateDirectory, now, ...(fetcher ? { fetcher } : {}) });
    if (reading.windows.length > 0) { windows = reading.windows; source = "endpoint"; readAt = reading.readAt; }
    // The endpoint is today's plan; a quiet log's plan_type can be months old (a lapsed Pro read as Pro).
    planName = reading.planName ?? planName;
    hint = reading.hint ?? hint;
  }
  return {
    id, plan: "codex", displayName: displayName("Codex", profile), profile, configDir: folder, email, planName,
    connected: auth !== undefined,
    hint,
    readAt, source, windows,
  };
}
