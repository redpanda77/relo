import { randomBytes } from "node:crypto";
import { chmod,lstat,mkdir,open,readFile,rename,rm } from "node:fs/promises";
import { dirname,join } from "node:path";
import { AdapterError } from "./adapter.mjs";

const MAX_STATE_BYTES = 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;

function emptyState() {
  return { version: 1,runs: {} };
}

function validEntry(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.lifecycle?.provider === "string"
    && typeof value.lifecycle?.runId === "string"
    && typeof value.origin?.thread === "string"
    && typeof value.updatedAt === "number";
}

async function readState(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new AdapterError("Unable to inspect the Codex lifecycle state.",3);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES
    || (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    || (process.platform !== "win32" && process.getuid && info.uid !== process.getuid())) {
    throw new AdapterError("Codex lifecycle state is not a private regular file.",3);
  }
  try {
    const parsed = JSON.parse(await readFile(path,"utf8"));
    if (parsed?.version !== 1 || !parsed.runs || typeof parsed.runs !== "object" || Array.isArray(parsed.runs)
      || Object.values(parsed.runs).some((entry) => !validEntry(entry))) {
      throw new Error("invalid");
    }
    return parsed;
  } catch {
    throw new AdapterError("Codex lifecycle state is invalid.",3);
  }
}

async function acquireLock(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await open(path,"wx",0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await lstat(path).catch(() => null);
      if (info && Date.now()-info.mtimeMs > 30_000) await rm(path,{ force: true }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve,20));
    }
  }
  throw new AdapterError("Codex lifecycle state is busy.",3);
}

async function writeState(path,state) {
  const directory = dirname(path);
  await mkdir(directory,{ recursive: true,mode: 0o700 });
  const temporary = join(directory,`.relo-lifecycle.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary,"wx",0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`,"utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(temporary,0o600);
    await rename(temporary,path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary,{ force: true }).catch(() => {});
    throw error;
  }
}

export class FileHookStateStore {
  constructor(path,{ now = Date.now } = {}) {
    this.path = path;
    this.now = now;
  }

  async mutate(update) {
    await mkdir(dirname(this.path),{ recursive: true,mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const lock = await acquireLock(lockPath);
    try {
      const state = await readState(this.path);
      const cutoff = this.now()-RETENTION_MS;
      state.runs = Object.fromEntries(Object.entries(state.runs).filter(([,entry]) => entry.updatedAt >= cutoff));
      const result = await update(state.runs);
      await writeState(this.path,state);
      return result;
    } finally {
      await lock.close().catch(() => {});
      await rm(lockPath,{ force: true }).catch(() => {});
    }
  }

  async get(runId) {
    return this.mutate((runs) => runs[runId] ?? null);
  }

  async put(entry) {
    return this.mutate((runs) => { runs[entry.lifecycle.runId] = entry; return entry; });
  }

  async activeForThread(thread) {
    return this.mutate((runs) => Object.values(runs).filter((entry) => entry.origin.thread === thread && !entry.terminal));
  }
}
