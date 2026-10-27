// OpenCode's plan usage for `relo usage`. OpenCode keeps its sign-in in `opencode.db` (the `credential` table, read with
// the sqlite3 binary in read-only mode) and, older, in `auth.json`; the database comes first because OpenCode 2 rotates the
// Go key into it and leaves the file's copy dead. An OpenCode Go plan key (or an OpenCode sign-in) asks the Go usage
// endpoint for its 5-hour, weekly and monthly windows; a machine that only has API keys of other providers has no plan
// limit, so the account carries no windows and, cheaply, the usage its local database counted (tokens for today, 5 hours, a week and a month, cost, by provider).
// The credential is read-only, used for the one request and never printed or cached. OpenCode-only, so it lives with the
// OpenCode adapter. A local reading, not Relo state.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import descriptor from "./descriptor.mjs";
import { cachedReading, retryAfterMs } from "../../../shared/usage-cache.mjs";

export const TTL_MS = 5 * 60_000;
export const GO_ENDPOINT = "https://opencode.ai/zen/go/v1/usage";
export const OAUTH_ENDPOINT = "https://opencode.ai/inference/go/v1/usage";
export const DEFAULT_CONSOLE = "https://opencode.ai/console";
const BINARY = descriptor.installation.binaries[0];
const SIGN_IN = `Sign in with "${BINARY} auth login".`;
export const API_KEYS_HINT = "No plan limit: OpenCode is using API keys.";
const GO = "opencode-go";
const SIGN_IN_ID = "opencode";

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const exists = (path) => stat(path).then(() => true, () => false);

/** OpenCode's data folder: $XDG_DATA_HOME/opencode when set, else ~/.local/share/opencode. */
export function dataDirectory(env, home) {
  const xdg = text(env?.XDG_DATA_HOME);
  return join(xdg ?? join(home, ".local", "share"), BINARY);
}

/** Whether OpenCode has been used on this computer: its sign-in file or database exists. */
export async function opencodePresent({ env, home }) {
  const folder = dataDirectory(env, home);
  return (await exists(join(folder, "auth.json"))) || (await exists(join(folder, "opencode.db")));
}

/** One stored credential value (a bare key, {type:"api",key} or {type:"oauth",access,...}) as { token, oauth, console, org, expires }, or undefined. */
export function credentialOf(entry) {
  const bare = text(entry);
  if (bare) return { token: bare, oauth: false, console: null, org: null, expires: null };
  if (!entry || typeof entry !== "object") return undefined;
  if (entry.type === "oauth") {
    const token = text(entry.access);
    const expires = Number(entry.expires);
    return token ? { token, oauth: true, console: text(entry.metadata?.server), org: text(entry.metadata?.orgID), expires: Number.isFinite(expires) && expires > 0 ? expires : null } : undefined;
  }
  const token = ["key", "apiKey", "api_key", "token", "accessToken"].map((name) => text(entry[name])).find(Boolean);
  return token ? { token, oauth: false, console: null, org: null, expires: null } : undefined;
}

const readJson = async (path) => { try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; } };

async function sqlRows(run, database, sql) {
  const output = await run("sqlite3", ["-readonly", "-json", database, sql]);
  try { const rows = JSON.parse(output); return Array.isArray(rows) ? rows : []; } catch { return []; }
}

/**
 * What OpenCode is signed in with: { plan: credential | undefined, others: how many other integrations hold a key }.
 * The Go plan's key (or the OpenCode sign-in) is the plan credential; any other integration id is an API key of another provider.
 */
export async function readCredentials({ folder, run }) {
  const found = { plan: undefined, others: 0 };
  const take = (id, value) => {
    if (id === GO || id === SIGN_IN_ID) {
      const credential = credentialOf(value);
      // The Go key outranks the sign-in, as in OpenCode's own order.
      if (credential && (!found.plan || (id === GO && !found.plan.go))) found.plan = { ...credential, go: id === GO };
    } else if (id) found.others += 1;
  };
  const database = join(folder, "opencode.db");
  if (await exists(database)) {
    // Newest first; a row with no `active` flag counts as active (OpenCode has shipped both shapes).
    const rows = await sqlRows(run, database, `SELECT integration_id, CASE WHEN integration_id IN ('${GO}','${SIGN_IN_ID}') THEN value END AS value FROM credential WHERE COALESCE(active, 1) != 0 ORDER BY time_updated DESC`);
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.integration_id)) continue;
      let value = row.value;
      try { value = typeof value === "string" ? JSON.parse(value) : value; } catch { /* a bare key */ }
      if (row.integration_id === GO || row.integration_id === SIGN_IN_ID) { if (credentialOf(value)) seen.add(row.integration_id); }
      else seen.add(row.integration_id);
      take(row.integration_id, value);
    }
  }
  // The file only serves what the database does not hold.
  if (!found.plan || found.others === 0) {
    const auth = await readJson(join(folder, "auth.json"));
    if (auth && typeof auth === "object") {
      for (const [id, value] of Object.entries(auth)) {
        if (id === GO || id === SIGN_IN_ID) { if (!found.plan) take(id, value); }
        else if (found.others === 0 && credentialOf(value)) take(id, value);
      }
    }
  }
  return found;
}

const MONTH_MINUTES = (resetsAt) => {
  const reset = new Date(resetsAt * 1000);
  const before = new Date(reset);
  before.setUTCMonth(before.getUTCMonth() - 1);
  return Math.round((reset - before) / 60_000);
};
const GO_WINDOWS = [["rolling", "five_hour", "5-hour", 300], ["weekly", "seven_day", "Week", 10_080], ["monthly", "monthly", "Month", null]];

/** The Go usage body ({ usage: { rolling, weekly, monthly: { percent, resetsAt } } }) as windows; [] when none is readable. */
export function goWindows(body) {
  const windows = [];
  for (const [id, kind, label, fixed] of GO_WINDOWS) {
    const entry = body?.usage?.[id];
    const percent = Number(entry?.percent);
    const at = Date.parse(String(entry?.resetsAt ?? ""));
    if (!Number.isFinite(percent) || entry?.percent === null || !Number.isFinite(at)) continue;
    const resetsAt = Math.round(at / 1000);
    windows.push({ kind, minutes: fixed ?? MONTH_MINUTES(resetsAt), label, usedPercent: Math.min(100, Math.max(0, percent)), resetsAt });
  }
  return windows;
}

async function goReading({ plan, fetcher, now }) {
  const headers = { Authorization: `Bearer ${plan.token}`, Accept: "application/json", ...(plan.org ? { "x-opencode-org-id": plan.org } : {}) };
  const response = await fetcher(plan.oauth ? OAUTH_ENDPOINT : GO_ENDPOINT, { headers, timeoutMs: 15_000 });
  if (response.status === 401) {
    // A planless OAuth account also answers 401: the console tells a bad token (401) from no Go plan (200).
    if (plan.oauth) {
      const base = (plan.console ?? DEFAULT_CONSOLE).replace(/\/+$/u, "");
      if ((await fetcher(`${base}/api/user`, { headers, timeoutMs: 15_000 })).status === 200) return { data: { windows: [], planName: null, connected: true, note: "No OpenCode Go subscription on this account." } };
    }
    if (plan.expires !== null && plan.expires <= now) return { hint: `OpenCode's sign-in expired. ${SIGN_IN}` };
    return { hint: SIGN_IN };
  }
  if (response.status === 403) return { data: { windows: [], planName: null, connected: true, note: "No OpenCode Go subscription on this key." } };
  if (response.status === 429) return { hint: "OpenCode asked to slow down; trying again later.", rateLimitedMs: retryAfterMs(response.retryAfter, now) };
  if (response.status < 200 || response.status >= 300) return { hint: response.status === 0 ? "OpenCode could not be reached; trying again later." : `OpenCode answered ${response.status}; trying again later.` };
  const windows = goWindows(response.json);
  return windows.length > 0 ? { data: { windows, planName: "Go" } } : { hint: "OpenCode reported no usage windows." };
}

const TOKENS = "COALESCE(json_extract(data,'$.tokens.total'), COALESCE(json_extract(data,'$.tokens.input'),0) + COALESCE(json_extract(data,'$.tokens.output'),0) + COALESCE(json_extract(data,'$.tokens.reasoning'),0) + COALESCE(json_extract(data,'$.tokens.cache.read'),0) + COALESCE(json_extract(data,'$.tokens.cache.write'),0))";
const HOUR_MS = 3_600_000;
const FRIENDLY = { opencode: "OpenCode Zen", "opencode-go": "OpenCode Go", anthropic: "Anthropic", openai: "OpenAI", "github-copilot": "GitHub Copilot", google: "Google", openrouter: "OpenRouter", firepass: "Fireworks Fire Pass", fireworks: "Fireworks" };
// Providers whose limits the owner's own subscription sets (the Claude and Codex rows of `relo usage` show them).
const SUBSCRIPTION_NOTES = { anthropic: "its limits show on the Claude row", openai: "its limits show on the Codex row" };

/** A provider id as the owner knows it ("firepass" -> "Fireworks Fire Pass", unknown ids title-cased). */
export function providerName(id) {
  if (FRIENDLY[id]) return FRIENDLY[id];
  return String(id).split(/[-_]/u).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") || "Unknown";
}

/**
 * What OpenCode's own database counted, from assistant messages: tokens for today, the last 5 hours, 7 days and this month, the
 * month's cost in USD (as `opencode stats` sums it; 0 on flat plans and free models) and the month by provider.
 * { activity, quotaErrors } where activity is undefined when there is no database or it holds no usage this month; `unreadable`
 * is true when the database exists but could not be read (told apart from "no rows").
 */
export async function activityOf({ folder, run, now }) {
  const database = join(folder, "opencode.db");
  if (!(await exists(database))) return { unreadable: false };
  // `unreadable` below: sqlite3 printed nothing (missing binary, locked or damaged file), which is not the same as no rows.
  const tables = new Set((await sqlRows(run, database, "SELECT name FROM sqlite_master WHERE type='table'")).map((row) => row.name));
  // 2.x has session_v2 (its messages are in session_message, the role in `type`); 1.x has message (the role in the JSON).
  const v2 = tables.has("session_v2") || (!tables.has("message") && tables.has("session_message"));
  if (!v2 && !tables.has("message")) return { unreadable: tables.size === 0 };
  const at = new Date(now);
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const month = new Date(at.getFullYear(), at.getMonth(), 1).getTime();
  const fiveHours = now - 5 * HOUR_MS;
  const week = now - 7 * 24 * HOUR_MS;
  const since = Math.min(month, week);
  const provider = v2 ? "$.model.providerID" : "$.providerID";
  const sum = (from, column) => `COALESCE(SUM(CASE WHEN time_created >= ${from} THEN ${column} ELSE 0 END), 0)`;
  const sql = `SELECT provider, ${sum(day, "t")} AS today, ${sum(fiveHours, "t")} AS five, ${sum(week, "t")} AS week, ${sum(month, "t")} AS month, ${sum(month, "c")} AS cost, ${sum(day, "c")} AS costToday, ${sum(day, "q")} AS quota, MAX(CASE WHEN t > 0 THEN time_created END) AS last FROM (SELECT time_created, COALESCE(json_extract(data,'${provider}'),'unknown') AS provider, ${TOKENS} AS t, COALESCE(json_extract(data,'$.cost'),0) AS c, CASE WHEN json_extract(data,'$.error.type') = 'provider.quota' THEN 1 ELSE 0 END AS q FROM ${v2 ? "session_message" : "message"} WHERE ${v2 ? "type = 'assistant'" : "json_extract(data,'$.role') = 'assistant'"} AND time_created >= ${since}) GROUP BY provider`;
  const output = await run("sqlite3", ["-readonly", "-json", database, sql]);
  // An aggregate over zero rows still prints a row set; no output at all means sqlite3 failed.
  if (!output.trim()) return { unreadable: true };
  let rows;
  try { rows = JSON.parse(output); } catch { return { unreadable: true }; }
  if (!Array.isArray(rows)) return { unreadable: true };
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const providers = rows.map((row) => ({ id: String(row.provider), tokensMonth: Math.round(number(row.month)), costMonth: Math.round(number(row.cost) * 1e4) / 1e4 })).filter((entry) => entry.tokensMonth > 0 || entry.costMonth > 0).sort((a, b) => b.tokensMonth - a.tokensMonth);
  const total = (field) => rows.reduce((all, row) => all + number(row[field]), 0);
  const quotaErrors = Math.round(total("quota"));
  if (providers.length === 0) return { unreadable: false, quotaErrors };
  const last = Math.max(...rows.map((row) => number(row.last)));
  return {
    unreadable: false, quotaErrors,
    activity: {
      tokensToday: Math.round(total("today")), tokens5h: Math.round(total("five")), tokensWeek: Math.round(total("week")), tokensMonth: Math.round(total("month")),
      costToday: Math.round(total("costToday") * 1e4) / 1e4, costMonth: Math.round(total("cost") * 1e4) / 1e4, providers,
      ...(last > 0 ? { lastUsedAt: Math.round(last / 1000) } : {}),
    },
  };
}

/** The plan name and hint for a local-only reading: the provider most used this month, and what limits apply to it. */
function localSummary(found, others) {
  const { activity, unreadable, quotaErrors } = found;
  if (!activity) {
    if (unreadable) return { planName: others > 0 ? "API keys" : null, hint: "OpenCode's database could not be read, so its usage is unknown." };
    return { planName: others > 0 ? "API keys" : null, hint: others > 0 ? API_KEYS_HINT : null, empty: true };
  }
  const top = activity.providers[0].id;
  const parts = [`No plan limit to read: usage is counted from OpenCode's own data (${providerName(top)}).`];
  if (SUBSCRIPTION_NOTES[top]) parts.push(`If it runs on a ${providerName(top)} subscription, ${SUBSCRIPTION_NOTES[top]}.`);
  if (quotaErrors > 0) parts.push(`Free usage limit reached today; subscribe to OpenCode Go to keep going.`);
  return { planName: top.startsWith("opencode") ? providerName(top) : `${providerName(top)} via OpenCode`, hint: parts.join(" ") };
}

/**
 * The cached OpenCode reading: { windows, planName, activity, connected, readAt, hint }. Five minutes between attempts (a
 * failure is cached too, a rate limit backs off); the last good windows are kept through a failure. `io`: { run: (file, args) => stdout,
 * fetch: (url, { headers, timeoutMs }) => { status, retryAfter, json } } are required (owner/usage/io.mjs has the real ones). Never throws.
 */
export async function opencodeReading({ folder, stateDirectory, now, io }) {
  const { run, fetch: fetcher } = io;
  const reading = await cachedReading({
    stateDirectory, name: "opencode", now, ttlMs: TTL_MS,
    attempt: async () => {
      const { plan, others } = await readCredentials({ folder, run });
      if (plan) {
        const outcome = await goReading({ plan, fetcher, now });
        return outcome.data ? { data: { ...outcome.data, connected: true } } : outcome;
      }
      const found = await activityOf({ folder, run, now });
      const local = localSummary(found, others);
      if (others > 0 || found.activity) return { data: { windows: [], planName: local.planName, connected: true, note: local.hint, activity: found.activity ?? null } };
      return { data: { windows: [], planName: null, connected: false, note: found.unreadable ? local.hint : SIGN_IN } };
    },
  });
  const live = (reading.data?.windows ?? []).filter((window) => window.resetsAt * 1000 > now);
  return {
    windows: live, planName: reading.data?.planName ?? null, activity: reading.data?.activity ?? null, connected: reading.data?.connected ?? false,
    readAt: live.length > 0 ? reading.readAt : null, hint: reading.hint ?? reading.data?.note ?? null,
  };
}
