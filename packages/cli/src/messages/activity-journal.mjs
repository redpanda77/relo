import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { statePath } from "../work/state-file.mjs";
import { dirname, isAbsolute, join } from "node:path";
import { ReloError, UsageError } from "../shared/errors.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key,canonical(value[key])]));
  return value;
}
function unavailable() { return new ReloError("The original activity command could not be preserved. No mutation was sent.",{ code: "ACTIVITY_CAPTURE_UNAVAILABLE" }); }
async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const handle = await open(path,constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function privateDirectory(path) {
  const created = await mkdir(path,{ recursive: true,mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32"
    && ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()))) throw unavailable();
  if (created) for (let cursor = path; ; cursor = dirname(cursor)) {
    await syncDirectory(cursor);
    // Stop at the parent of the first folder made, or at the filesystem root: on Windows mkdir reports the
    // path in a different spelling than dirname builds, so the equality alone never matched and looped forever.
    if (cursor === dirname(created) || dirname(cursor) === cursor) break;
  }
}
function validate(record) {
  if (!record || record.version !== 1 || Object.keys(record).length !== 5
    || !/^[a-f0-9]{64}$/.test(record.intentHash)
    || typeof record.occurredAt !== "string" || !Number.isFinite(Date.parse(record.occurredAt))
    || new Date(record.occurredAt).toISOString() !== record.occurredAt
    || !(record.target === null && record.ifSequence === null
      || typeof record.target === "string" && /^act_[a-f0-9-]{36}$/.test(record.target)
        && Number.isSafeInteger(record.ifSequence) && record.ifSequence >= 0)) throw unavailable();
  return record;
}
async function readRecord(path) {
  const handle = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 || (process.platform !== "win32"
      && ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()))) throw unavailable();
    return validate(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
}

/** Immutable metadata only: no body, prompt, token, URL or user identity. A single
 * atomic link chooses the winner across processes; retries never reselect a target.
 * These tiny replay fences intentionally outlive prunable hook/history caches. */
export async function captureActivityCommand({ config,key,operation,selector,body,occurredAt,resolve }, {
  root,environment = process.env,home,
} = {}) {
  const directory = root ?? statePath({ env: environment, home },"activity-commands");
  if (!isAbsolute(directory) || typeof config.apiUrl !== "string" || typeof config.token !== "string") throw unavailable();
  const digest = hash(JSON.stringify(["relo-activity-command-v1",config.apiUrl,hash(config.token),key]));
  const intentHash = hash(JSON.stringify(canonical({ operation,selector,body: { ...body,ifSequence: undefined } })));
  const shard = join(directory,digest.slice(0,2)), path = join(shard,`${digest.slice(2)}.json`);
  let temporary,handle;
  const match = record => {
    if (record.intentHash !== intentHash) throw new UsageError("This activity idempotency key already identifies a different command.");
    return record;
  };
  try {
    await privateDirectory(directory); await privateDirectory(shard);
    try { const record = match(await readRecord(path)); await syncDirectory(shard); return record; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    // This timestamp was captured before authentication/resolution/network work.
    const time = new Date(occurredAt);
    if (!Number.isFinite(time.getTime())) throw new UsageError("occurredAt must be an original ISO occurrence time");
    const selected = operation === "start" ? { target: null,ifSequence: null } : await resolve();
    const record = validate({ version: 1,intentHash,occurredAt: time.toISOString(),...selected });
    temporary = join(shard,`.${digest}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    handle = await open(temporary,"wx",0o600); await handle.writeFile(JSON.stringify(record)+"\n");
    await handle.sync(); await handle.close(); handle = undefined;
    try { await link(temporary,path); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    await syncDirectory(shard); await syncDirectory(directory);
    return match(await readRecord(path));
  } catch (error) {
    if (error instanceof ReloError) throw error;
    throw unavailable();
  } finally {
    await handle?.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
