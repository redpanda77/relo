// Antigravity's plan quota for `relo usage`, asked of Antigravity's own language server on this computer (the IDE's
// `language_server` or the `agy` CLI), the way Antigravity's own window does: the server already holds the sign-in and the
// client identity, so Relo holds no credential. With none running but the IDE installed, Relo starts the IDE's language
// server once, standalone, detached and under its own data folder, and the next runs find it again in the process list
// (a short note of its pid and token sits in the usage cache folder, so a still-booting server is waited for, not doubled);
// otherwise the last reading stays with a hint. The server speaks HTTPS on 127.0.0.1 with a self-signed certificate,
// accepted for that address only (by the loopback poster in owner/usage/io.mjs; adapters stay off the network). The CSRF token comes from the process list, is sent once and never printed or stored.
// Antigravity-only, so it lives with the Antigravity adapter. A local reading, not Relo state.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import descriptor from "./descriptor.mjs";
import { writeFileAtomic } from "../../../shared/atomic-write.mjs";
import { cachedReading } from "../../../shared/usage-cache.mjs";

export const TTL_MS = 2 * 60_000;
export const MISS_TTL_MS = 30_000;
export const NOT_RUNNING_HINT = "Reads while Antigravity or agy runs.";
export const NOT_CONNECTED_HINT = "Antigravity's language server did not answer yet; trying again soon.";
const SERVICE = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const CSRF_HEADER = "x-codeium-csrf-token";
const CLI = descriptor.installation.binaries[0];
const APP = descriptor.installation.apps[0];
const SERVER_BINARY = join("Contents", "Resources", "bin", "language_server");
const SERVER_RECORD = "antigravity-server.json";
// A name, not a path: the server resolves it under ~/.gemini and refuses an absolute one. Its own folder keeps it off the IDE's files.
const APP_DATA_NAME = "relo-usage-bridge";
const PORT_WAIT_MS = 10_000; // a started server listens within a moment ...
const BOOT_WAIT_MS = 20_000; // ... and authenticates for about eight seconds more
const HOURLY_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const exists = (path) => stat(path).then(() => true, () => false);

// The folders an app is installed in: system-wide first, but only for the real home (any other home is a sandbox or another account's).
const applicationFolders = (home) => (home === homedir() ? ["/Applications"] : []).concat(join(home, "Applications"));

// Whether this computer has Antigravity at all: its data folders under the home, its app (system-wide or the user's), or its binary.
export async function antigravityPresent({ env, home, exists: has = exists }) {
  const spots = (descriptor.installation.markers ?? []).map((marker) => marker.replace(/^~\//u, `${home}/`));
  spots.push(join(home, ".gemini", `${descriptor.id}-cli`), join(home, ".local", "bin", CLI));
  for (const app of descriptor.installation.apps ?? []) for (const folder of applicationFolders(home)) spots.push(join(folder, app));
  for (const folder of String(env?.PATH ?? "").split(delimiter).filter(Boolean)) spots.push(join(folder, CLI));
  for (const spot of spots) if (await has(spot)) return true;
  return false;
}

/** The email Antigravity (the Gemini folder) is signed in with, from google_accounts.json's `active` field only; or null. */
export async function antigravityEmail(home) {
  try {
    const active = JSON.parse(await readFile(join(home, ".gemini", "google_accounts.json"), "utf8"))?.active;
    return text(active) && /@/u.test(active) ? active.trim() : null;
  } catch { return null; }
}

const flagValue = (line, flag) => {
  const parts = line.split(/\s+/u);
  const index = parts.indexOf(flag);
  return index >= 0 && index + 1 < parts.length ? parts[index + 1] : undefined;
};

/**
 * The language servers in a `ps -Ao pid,command` listing: the IDE's (a `language_server` with --csrf_token) first, then the
 * `agy` CLI (no token needed on loopback). [{ pid, token }]; the token is for the request only.
 */
export function findServers(psOutput) {
  const lines = String(psOutput ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const pidOf = (line) => { const pid = Number(line.split(/\s+/u)[0]); return Number.isInteger(pid) && pid > 0 ? pid : undefined; };
  const found = [];
  for (const line of lines) {
    const pid = pidOf(line);
    const token = flagValue(line, "--csrf_token");
    if (pid && token && line.includes("language_server")) found.push({ pid, token });
  }
  for (const line of lines) {
    const pid = pidOf(line);
    const executable = line.split(/\s+/u)[1] ?? "";
    // The executable's own name: "agy" is three letters and turns up inside real words and paths.
    if (pid && executable.split("/").pop() === CLI) found.push({ pid, token: null });
  }
  return found;
}

/** Listening TCP ports in `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` output. */
export function parsePorts(lsofOutput) {
  const ports = [];
  for (const line of String(lsofOutput ?? "").split("\n")) {
    const address = line.split(/\s+/u).reverse().find((field) => field.includes(":") && !field.startsWith("("));
    const port = Number(address?.split(":").pop());
    if (Number.isInteger(port) && port > 0 && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

/** The quota request for the loopback poster: the path, the CSRF header (only where there is a token) and a refresh-forcing body. */
export const quotaRequest = ({ port, token }) => ({ port, path: SERVICE, headers: token ? { [CSRF_HEADER]: token } : {}, body: JSON.stringify({ forceRefresh: true }) });

// ---- parsing (the shapes of Antigravity's quota envelopes) ----

const slugOf = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "quota";
const normalized = (value) => String(value ?? "").trim().toLowerCase().replace(/_/gu, "-");
const trimmedLimit = (value) => { const v = normalized(value); return v.endsWith(" limit") ? v.slice(0, -6) : v; };
const isWeeklyValue = (v) => v === "weekly" || v === "week" || v.endsWith("-weekly") || v.endsWith(" weekly");
const isSessionValue = (v) => v === "session" || v === "5h" || v === "5-hour" || v === "five hour" || v === "five-hour" || v === "hourly"
  || v.endsWith("-session") || v.endsWith("-5h") || v.endsWith("-5-hour") || v.endsWith("-five-hour") || v.endsWith("-hourly");

/** "weekly", "hourly" or undefined, from a bucket's window, id and display name. */
export function cadenceOf(bucket) {
  const values = [bucket?.window, bucket?.bucketId, bucket?.displayName].filter((value) => typeof value === "string" && value.trim()).map(trimmedLimit);
  if (values.some(isWeeklyValue)) return "weekly";
  if (values.some(isSessionValue)) return "hourly";
  return undefined;
}

const fractionOf = (bucket) => {
  if (typeof bucket?.remainingFraction === "number") return bucket.remainingFraction;
  const remaining = bucket?.remaining;
  if (typeof remaining?.remainingFraction === "number") return remaining.remainingFraction;
  return remaining?.case === "remainingFraction" && typeof remaining.value === "number" ? remaining.value : undefined;
};
const resetOf = (bucket) => { const at = Date.parse(String(bucket?.resetTime ?? "")); return Number.isFinite(at) ? Math.round(at / 1000) : null; };
const idOf = (bucket, group) => [bucket?.bucketId, bucket?.modelId, bucket?.name, group].map(text).find(Boolean) ?? "quota";

// "Gemini Models" -> Gemini; "Claude and GPT models" -> Other models; any other group keeps its own name.
function family(name) {
  const value = normalized(name);
  if (value.includes("gemini")) return { slug: "gemini", name: "Gemini", rank: 0 };
  if (value.includes("claude") || value.includes("gpt") || value.includes("openai")) return { slug: "other", name: "Other models", rank: 1 };
  const own = text(name);
  return { slug: normalized(own ?? "quota").replace(/[^a-z0-9]+/gu, "-"), name: own, rank: 2 };
}
const CADENCE = { hourly: { suffix: "hourly", minutes: HOURLY_MINUTES, word: "5-hour" }, weekly: { suffix: "weekly", minutes: WEEKLY_MINUTES, word: "week" } };

// A window and the bucket it came from (its id and name tell two windows of one cadence apart).
function windowOf(bucket, group, now) {
  if (bucket?.disabled === true) return undefined;
  const remaining = fractionOf(bucket);
  let used;
  if (typeof remaining === "number" && remaining >= 0 && remaining <= 1) used = (1 - remaining) * 100;
  else if (typeof bucket?.limit === "number" && bucket.limit > 0 && typeof bucket.used === "number" && bucket.used >= 0 && bucket.used <= bucket.limit * 1.5) used = (bucket.used / bucket.limit) * 100;
  else return undefined;
  const resetsAt = resetOf(bucket);
  const cadence = cadenceOf(bucket) ?? (resetsAt !== null && resetsAt * 1000 - now > 24 * 3_600_000 ? "weekly" : undefined);
  const info = cadence ? CADENCE[cadence] : undefined;
  const base = group ? family(group) : undefined;
  const bucketName = text(bucket?.displayName)?.replace(/ Remaining$/u, "");
  const word = info?.word ?? bucketName ?? idOf(bucket, null);
  return {
    kind: [base?.slug, info?.suffix ?? slugOf(idOf(bucket, null))].filter(Boolean).join("-"),
    minutes: info?.minutes ?? null,
    label: [base?.name, word].filter(Boolean).join(" "),
    usedPercent: Math.min(100, Math.max(0, Math.round(used * 10) / 10)),
    resetsAt,
    bucket,
  };
}

// Windows sharing a kind (two buckets of one cadence in a group) take their bucket's id as a suffix on the kind and its name on the label; the bucket is dropped.
function distinct(entries) {
  const seen = new Map();
  for (const entry of entries) seen.set(entry.kind, (seen.get(entry.kind) ?? 0) + 1);
  const used = new Set();
  return entries.map(({ bucket, ...window }, index) => {
    if (seen.get(window.kind) < 2) return window;
    const id = slugOf(idOf(bucket, null));
    const name = text(bucket?.displayName)?.replace(/ Remaining$/u, "");
    let kind = `${window.kind}-${id}`;
    if (used.has(kind)) kind = `${kind}-${index + 1}`;
    used.add(kind);
    return { ...window, kind, label: name && !window.label.includes(name) ? `${window.label} (${name})` : window.label };
  });
}

// Flat per-model buckets with only remaining fractions: one window per family and cadence (the tightest).
function modelWindows(buckets, now) {
  const best = new Map();
  for (const bucket of buckets) {
    const remaining = fractionOf(bucket);
    const model = normalized(idOf(bucket, null));
    if (!(remaining >= 0 && remaining <= 1) || model.startsWith("chat-")) continue;
    const base = model.includes("gemini") ? family("gemini") : /claude|gpt|openai/u.test(model) ? family("claude") : undefined;
    if (!base) continue;
    const resetsAt = resetOf(bucket);
    const cadence = cadenceOf(bucket) === "weekly" || (resetsAt !== null && resetsAt * 1000 - now > 24 * 3_600_000) ? "weekly" : "hourly";
    const key = `${base.slug}-${cadence}`;
    if (!best.has(key) || remaining < best.get(key).remaining) best.set(key, { remaining, resetsAt, base, cadence });
  }
  return [...best.entries()].sort((a, b) => a[1].base.rank - b[1].base.rank || (a[1].cadence === "hourly" ? -1 : 1)).map(([kind, entry]) => ({
    kind, minutes: CADENCE[entry.cadence].minutes, label: `${entry.base.name} ${CADENCE[entry.cadence].word}`,
    usedPercent: Math.round((1 - entry.remaining) * 1000) / 10, resetsAt: entry.resetsAt,
  }));
}

/** The quota windows of a RetrieveUserQuotaSummary body (grouped, flat, or legacy limit/used buckets), or []. */
export function parseQuota(body, now) {
  const groups = body?.response?.groups ?? body?.summary?.groups ?? body?.groups ?? body?.quotaGroups ?? [];
  if (Array.isArray(groups) && groups.length > 0) {
    return distinct(groups.map((group, index) => ({ group, index })).sort((a, b) => family(a.group?.displayName).rank - family(b.group?.displayName).rank || a.index - b.index)
      .flatMap(({ group }) => (Array.isArray(group?.buckets) ? group.buckets : []).map((bucket, index) => ({ bucket, index }))
        .sort((a, b) => ({ hourly: 0, weekly: 1 }[cadenceOf(a.bucket)] ?? 2) - ({ hourly: 0, weekly: 1 }[cadenceOf(b.bucket)] ?? 2) || a.index - b.index)
        .map(({ bucket }) => windowOf(bucket, text(group?.displayName) ?? "quota", now)).filter(Boolean)));
  }
  const buckets = Array.isArray(body?.buckets) ? body.buckets : [];
  if (buckets.length === 0) return [];
  if (buckets.some((bucket) => bucket?.limit !== undefined)) return distinct(buckets.map((bucket) => windowOf(bucket, null, now)).filter(Boolean));
  return modelWindows(buckets, now);
}

/** The plan name, if the server names one at the places it is known to. */
export const planOf = (body) => text(body?.planName) ?? text(body?.response?.planName) ?? text(body?.tier?.name) ?? text(body?.userTier?.name);

// ---- the server: a running one, else one of our own ----

/** The IDE's language server binary, in the system or the user's Applications folder; or null. */
async function serverBinary(home, has) {
  for (const folder of applicationFolders(home)) {
    const path = join(folder, APP, SERVER_BINARY);
    if (await has(path)) return path;
  }
  return null;
}

/** The flags the IDE gives its own server, minus everything that ties it to a running IDE. */
export const serverArguments = (token) => [
  "--standalone", "--override_ide_name", descriptor.id, "--subclient_type", "hub", "--override_user_agent_name", descriptor.id,
  "--https_server_port", "0", "--csrf_token", token, "--app_data_dir", APP_DATA_NAME,
  "--api_server_url", "https://generativelanguage.googleapis.com", "--cloud_code_endpoint", "https://daily-cloudcode-pa.googleapis.com",
];

async function ownRecord(stateDirectory) {
  try {
    const record = JSON.parse(await readFile(join(stateDirectory, "usage", SERVER_RECORD), "utf8"));
    return Number.isInteger(record?.pid) && text(record?.token) ? record : undefined;
  } catch { return undefined; }
}

// Starts the server detached and notes its pid, token and start time (so the next run recognizes it); { pid, token } or null.
async function startServer({ stateDirectory, home, now, io }) {
  const binary = await serverBinary(home, io.exists);
  if (!binary) return null;
  const token = randomUUID();
  const pid = await io.spawnDetached(binary, serverArguments(token));
  if (!pid) return null;
  try {
    await mkdir(join(stateDirectory, "usage"), { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(stateDirectory, "usage", SERVER_RECORD), JSON.stringify({ pid, token, startedAt: now }));
  } catch { /* it still runs; the process list finds it */ }
  return { pid, token };
}

// One pass over a server's listening ports: the first quota that answers, or undefined; and whether a port was open at all.
async function ask(server, { run, post }, now) {
  const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  const ports = parsePorts(await run(lsof, ["-nP", "-a", "-p", String(server.pid), "-iTCP", "-sTCP:LISTEN"]));
  for (const port of ports) {
    const response = await post(quotaRequest({ port, token: server.token }));
    if (response.status !== 200) continue;
    const windows = parseQuota(response.json, now);
    if (windows.length > 0) return { found: { windows, planName: planOf(response.json) }, ports };
  }
  return { found: undefined, ports };
}

// A server we started may still be binding and authenticating: ask again every 250 ms for its port, every second once it has one.
async function askStarting(server, io, now) {
  for (let waited = 0; ; ) {
    const { found, ports } = await ask(server, io, now);
    if (found) return found;
    if ((ports.length === 0 && waited >= PORT_WAIT_MS) || waited >= BOOT_WAIT_MS) return undefined;
    const step = ports.length === 0 ? 250 : 1000;
    await io.sleep(step);
    waited += step;
  }
}

/**
 * The cached quota reading: { windows, planName, readAt, hint, running }. At most one attempt per 2 minutes (a miss is
 * cached for 30 seconds); with no server running and none to start the last reading stays with the hint. `io`: { run(file, args) ->
 * stdout, post(request) -> { status, json }, spawnDetached(file, args) -> pid, exists(path), sleep(ms) } (owner/usage/io.mjs has the
 * real ones). Never throws.
 */
export async function antigravityReading({ stateDirectory, now, home, io = {} }) {
  const { run } = io;
  let missed = false;
  try { missed = Boolean(JSON.parse(await readFile(join(stateDirectory, "usage", "antigravity.json"), "utf8"))?.hint); } catch { /* no reading yet */ }
  const reading = await cachedReading({
    stateDirectory, name: "antigravity", now, ttlMs: missed ? MISS_TTL_MS : TTL_MS,
    attempt: async () => {
      let servers = findServers(await run("/bin/ps", ["-Ao", "pid,command"]));
      const own = await ownRecord(stateDirectory);
      let starting = servers.find((server) => own && server.pid === own.pid && server.token === own.token);
      if (servers.length === 0) {
        starting = await startServer({ stateDirectory, home, now, io });
        if (!starting) return { hint: NOT_RUNNING_HINT };
        servers = [starting];
      }
      for (const server of servers.filter((one) => one !== starting)) {
        const { found } = await ask(server, io, now);
        if (found) return { data: found };
      }
      if (starting) {
        const found = await askStarting(starting, io, now);
        return found ? { data: found } : { hint: NOT_CONNECTED_HINT };
      }
      return { hint: "Antigravity is running but gave no quota yet; trying again soon." };
    },
  });
  const live = (reading.data?.windows ?? []).filter((window) => window.resetsAt === null || window.resetsAt * 1000 > now);
  return { windows: live, planName: reading.data?.planName ?? null, readAt: live.length > 0 ? reading.readAt : null, hint: reading.hint };
}
