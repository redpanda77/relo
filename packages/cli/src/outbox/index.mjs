// Durable outbox (EDGE.3, ADR 0008 principle 13). Everything the CLI sends to the server on behalf of a
// hook or a declared command can go through here, so a hook never waits on the network and nothing is
// lost when the server or the network is down.
//
// API
//   outboxDirectory({ env?, home? }) -> string
//     The default directory: <stateRoot>/outbox ($RELO_STATE_DIR, $XDG_STATE_HOME/relo, or ~/.local/state/relo).
//
//   serverOrigin(apiUrl) -> string | undefined
//     The origin an entry is queued for (e.g. "https://relo.example.test"); undefined when not a URL.
//
//   enqueue({ directory, lane, entry }) -> Promise<{ id }>
//     lane: "observed" | "declared".
//     entry: { server, route, method, body, idempotencyKey, credential: "harness" | "cli", sessionKey?, meta? }
//       server         the API origin this entry is for (the apiUrl of the config or credential that
//                      queued it); a flush for any other server never sends it
//       route          path on the Relo server, e.g. "/api/agent-sessions/observed"
//       method         "POST" | "PATCH" | "PUT" | "DELETE"
//       body           JSON-serialisable request body (already sealed/filtered by the caller)
//       idempotencyKey stable key the sender passes as the Idempotency-Key header
//       credential     which stored credential authenticates the request
//       sessionKey     required on the observed lane: the session the snapshot describes
//       meta           optional local-only JSON for the sender (e.g. names to seal at send time); it is
//                      stored with the entry and handed to send(), never part of the request by itself
//     Observed lane: a newer snapshot for the same sessionKey REPLACES the pending older one (latest
//     wins; the body's seq protects order on the server). Declared lane: strict FIFO, never collapsed.
//
//   flush({ directory, send, server, budgetMs = 10_000, now? }) -> Promise<{ sent, pending, dead, locked? }>
//     server: the API origin `send` talks to (required). An entry queued for another server (or for none)
//     is never sent: it is dropped into dead.json with the reason "queued for another server". Entries
//     queued by a test, another profile or an old login can never reach the server that flushes now.
//     send(entry) -> Promise<{ status }>, or throws. A thrown error without a numeric `status` is a
//     network failure; one with `status` is treated like that HTTP status.
//     One flusher at a time (lock file, stale lock recovered). Each lane goes oldest first and stops at
//     the first network failure or 5xx/408/425/429 (kept for later, order preserved). Any other 4xx is
//     permanent: the entry is dropped and recorded in dead.json with the reason. When another flusher
//     holds the lock it returns at once with { locked: true }.
//
//   pending({ directory }) -> Promise<{ observed, declared, total, oldestAt, dead }>
//     Counts for `relo state`, `relo doctor` and `relo outbox status`. `dead` is the recent dead list.
//
//   discard({ directory, lane }) -> Promise<number>
//     Drops every pending entry of a lane (e.g. observed snapshots once hooks are turned off and the
//     harness credential is revoked). Returns how many were dropped.
//
//   isFlushing({ directory, now? }) -> Promise<boolean>
//     True when a live flusher holds the lock (the hook uses it to avoid spawning a second one).
//
// Storage: one JSON file per entry (directory/<lane>/<name>.json), written to a temp file and renamed, so
// concurrent hook processes never read-modify-write a shared file and a crash leaves no half entry.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateRoot } from "../work/state-file.mjs";

export const LANES = Object.freeze(["observed", "declared"]);
const CREDENTIALS = new Set(["harness", "cli"]);
const METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const LOCK_FILE = "flush.lock";
const DEAD_FILE = "dead.json";
const DEAD_KEEP = 50;
// A flusher that crashed leaves its lock behind; past this age (or once its pid is gone) it is stale.
export const STALE_LOCK_MS = 60_000;
const MAX_ENTRY_BYTES = 256 * 1024;
let counter = 0;

export function outboxDirectory({ env = process.env, home = homedir() } = {}) {
  // The same state folder as every other state file (RELO_STATE_DIR, XDG_STATE_HOME, then the process's
  // RELO_STATE_DIR), so an injected env without a state folder never resolves to the real one in tests.
  return join(stateRoot(env, home), "outbox");
}

export function serverOrigin(apiUrl) {
  if (typeof apiUrl !== "string" || !apiUrl.trim()) return undefined;
  try {
    const { origin } = new URL(apiUrl.trim());
    return origin && origin !== "null" ? origin : undefined;
  } catch {
    return undefined;
  }
}

function validEntry(lane, entry) {
  if (!LANES.includes(lane)) throw new TypeError(`outbox lane must be one of ${LANES.join(", ")}`);
  if (!entry || typeof entry !== "object") throw new TypeError("outbox entry is required");
  const server = serverOrigin(entry.server);
  if (!server) throw new TypeError("outbox entry needs the server it is queued for");
  if (typeof entry.route !== "string" || !entry.route.startsWith("/api/")) throw new TypeError("outbox entry needs an /api/ route");
  const method = String(entry.method ?? "POST").toUpperCase();
  if (!METHODS.has(method)) throw new TypeError("outbox entry has an unsupported method");
  if (!CREDENTIALS.has(entry.credential)) throw new TypeError("outbox entry credential must be harness or cli");
  if (typeof entry.idempotencyKey !== "string" || !entry.idempotencyKey) throw new TypeError("outbox entry needs an idempotencyKey");
  if (lane === "observed" && (typeof entry.sessionKey !== "string" || !entry.sessionKey)) {
    throw new TypeError("observed outbox entries need a sessionKey");
  }
  return {
    server,
    route: entry.route,
    method,
    body: entry.body ?? null,
    idempotencyKey: entry.idempotencyKey,
    credential: entry.credential,
    ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
    ...(entry.meta !== undefined ? { meta: entry.meta } : {})
  };
}

function sessionFileName(sessionKey) {
  return `s-${createHash("sha256").update(sessionKey).digest("hex").slice(0, 32)}.json`;
}

function fifoFileName(now) {
  // Sortable: time first, then a per-process counter and randomness so two processes never collide.
  counter = (counter + 1) % 1_000_000;
  return `${String(now).padStart(15, "0")}-${String(counter).padStart(6, "0")}-${randomBytes(4).toString("hex")}.json`;
}

async function writeAtomic(path, dir, text) {
  const temp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, path);
}

export async function enqueue({ directory, lane, entry, now = Date.now() }) {
  if (!directory) throw new TypeError("outbox directory is required");
  const clean = validEntry(lane, entry);
  const dir = join(directory, lane);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = lane === "observed" ? sessionFileName(clean.sessionKey) : fifoFileName(now);
  const text = JSON.stringify({ v: 1, lane, enqueuedAt: new Date(now).toISOString(), entry: clean });
  if (Buffer.byteLength(text) > MAX_ENTRY_BYTES) throw new RangeError("outbox entry is too large");
  await writeAtomic(join(dir, name), dir, text);
  return { id: `${lane}/${name}` };
}

async function readEntry(path) {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    return data?.v === 1 && data.entry ? data : undefined;
  } catch {
    return undefined;
  }
}

// Pending files of a lane, oldest first. Observed files are named by session, so they sort by enqueue time.
async function laneFiles(directory, lane) {
  const dir = join(directory, lane);
  let names;
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json") && !name.startsWith("."));
  } catch {
    return [];
  }
  if (lane === "declared") return names.sort().map((name) => ({ name, path: join(dir, name) }));
  const withTimes = await Promise.all(names.map(async (name) => {
    const path = join(dir, name);
    const data = await readEntry(path);
    return { name, path, at: data?.enqueuedAt ?? "" };
  }));
  return withTimes.sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLock(directory) {
  try {
    return JSON.parse(await readFile(join(directory, LOCK_FILE), "utf8"));
  } catch {
    return undefined;
  }
}

function lockIsLive(lock, now) {
  if (!lock) return false;
  const at = Date.parse(lock.at ?? "");
  if (!Number.isFinite(at) || now - at > STALE_LOCK_MS) return false;
  return pidAlive(lock.pid);
}

export async function isFlushing({ directory, now = Date.now() }) {
  return lockIsLive(await readLock(directory), now);
}

async function acquireLock(directory, now) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, LOCK_FILE);
  const token = randomBytes(8).toString("hex");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date(now).toISOString(), token }));
      await handle.close();
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lock = await readLock(directory);
      if (lockIsLive(lock, now)) return undefined;
      // Stale: the holder died or ran far past any budget. Remove it and try once more; a racing
      // flusher that wins the exclusive create keeps the lock.
      await rm(path, { force: true });
    }
  }
  return undefined;
}

async function releaseLock(directory, token) {
  const lock = await readLock(directory);
  if (lock?.token === token) await rm(join(directory, LOCK_FILE), { force: true });
}

function classify(result) {
  const status = Number(result?.status);
  if (!Number.isFinite(status)) return { kind: "network" };
  if (status >= 200 && status < 300) return { kind: "sent" };
  if (status === 408 || status === 425 || status === 429 || status >= 500) return { kind: "retry", status };
  if (status >= 400) return { kind: "dead", status };
  return { kind: "retry", status };
}

async function recordDead(directory, item) {
  const path = join(directory, DEAD_FILE);
  let list = [];
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (Array.isArray(data)) list = data;
  } catch { /* first one */ }
  list.push(item);
  await writeAtomic(path, directory, JSON.stringify(list.slice(-DEAD_KEEP)));
}

async function readDead(directory) {
  try {
    const data = JSON.parse(await readFile(join(directory, DEAD_FILE), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function flushLane({ directory, lane, send, server, deadline, clock, counts }) {
  for (const file of await laneFiles(directory, lane)) {
    if (clock() >= deadline) return;
    // Claim the file by renaming it, so an observed snapshot enqueued while we send lands in a fresh
    // file and is not deleted with the one we sent.
    const inflight = join(directory, lane, `.inflight-${file.name}`);
    try {
      await rename(file.path, inflight);
    } catch {
      continue;
    }
    const data = await readEntry(inflight);
    if (!data) {
      await rm(inflight, { force: true });
      continue;
    }
    if (data.entry.server !== server) {
      // Queued for another server (a test, another profile, an old login) or for none: never sent.
      counts.dead += 1;
      await recordDead(directory, { at: new Date(clock()).toISOString(), lane, route: data.entry.route, reason: "queued for another server" });
      await rm(inflight, { force: true });
      continue;
    }
    let outcome;
    try {
      outcome = classify(await send(data.entry));
    } catch (error) {
      outcome = Number.isFinite(Number(error?.status)) ? classify({ status: error.status }) : { kind: "network" };
    }
    if (outcome.kind === "sent") {
      counts.sent += 1;
      await rm(inflight, { force: true });
      continue;
    }
    if (outcome.kind === "dead") {
      counts.dead += 1;
      await recordDead(directory, {
        at: new Date(clock()).toISOString(),
        lane,
        route: data.entry.route,
        status: outcome.status,
        reason: `rejected with HTTP ${outcome.status}`
      });
      await rm(inflight, { force: true });
      continue;
    }
    // Keep it. On the observed lane a newer snapshot for the same session may have arrived meanwhile;
    // it replaces this one, so put ours back only if the slot is still empty.
    const exists = await stat(file.path).then(() => true, () => false);
    if (lane === "observed" && exists) await rm(inflight, { force: true });
    else await rename(inflight, file.path).catch(() => {});
    return;
  }
}

// Inflight files left by a flusher that crashed mid-send go back in the queue (or yield to a newer
// observed snapshot).
async function recoverInflight(directory) {
  for (const lane of LANES) {
    const dir = join(directory, lane);
    let names = [];
    try {
      names = (await readdir(dir)).filter((name) => name.startsWith(".inflight-"));
    } catch {
      continue;
    }
    for (const name of names) {
      const original = join(dir, name.slice(".inflight-".length));
      const exists = await stat(original).then(() => true, () => false);
      if (exists) await rm(join(dir, name), { force: true });
      else await rename(join(dir, name), original).catch(() => {});
    }
  }
}

export async function flush({ directory, send, server, budgetMs = 10_000, now = () => Date.now() }) {
  if (!directory) throw new TypeError("outbox directory is required");
  if (typeof send !== "function") throw new TypeError("outbox flush needs a send function");
  const origin = serverOrigin(server);
  if (!origin) throw new TypeError("outbox flush needs the server it sends to");
  const clock = typeof now === "function" ? now : () => now;
  const token = await acquireLock(directory, clock());
  if (!token) return { sent: 0, pending: (await pending({ directory })).total, dead: 0, locked: true };
  const counts = { sent: 0, dead: 0 };
  try {
    await recoverInflight(directory);
    const deadline = clock() + Math.max(0, budgetMs);
    for (const lane of LANES) {
      await flushLane({ directory, lane, send, server: origin, deadline, clock, counts });
    }
  } finally {
    await releaseLock(directory, token);
  }
  return { sent: counts.sent, pending: (await pending({ directory })).total, dead: counts.dead };
}

export async function pending({ directory }) {
  const result = { observed: 0, declared: 0, total: 0, oldestAt: null, dead: await readDead(directory) };
  for (const lane of LANES) {
    const files = await laneFiles(directory, lane);
    result[lane] = files.length;
    result.total += files.length;
    for (const file of files) {
      const at = file.at ?? (await readEntry(file.path))?.enqueuedAt;
      if (at && (!result.oldestAt || at < result.oldestAt)) result.oldestAt = at;
      if (lane === "declared") break; // FIFO: the first is the oldest
    }
  }
  return result;
}

export async function discard({ directory, lane }) {
  if (!LANES.includes(lane)) throw new TypeError(`outbox lane must be one of ${LANES.join(", ")}`);
  const files = await laneFiles(directory, lane);
  for (const file of files) await rm(file.path, { force: true });
  return files.length;
}
