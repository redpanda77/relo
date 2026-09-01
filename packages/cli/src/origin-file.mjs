import { lstat,readFile } from "node:fs/promises";
import { UsageError } from "./errors.mjs";

const MAX_ORIGIN_FILE_BYTES = 32 * 1024;
const ORIGIN_LIMITS = Object.freeze({
  sourceInstance: 160,
  project: 160,
  thread: 200,
  channel: 80,
});
const LIFECYCLE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,39}$/u;
const LIFECYCLE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

function validOrigin(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== Object.keys(ORIGIN_LIMITS).sort().join(",")) return false;
  return Object.entries(ORIGIN_LIMITS).every(([key,maximum]) => {
    const field = value[key];
    return typeof field === "string" && field.trim().length > 0
      && Array.from(field.trim()).length <= maximum;
  });
}

export function normalizeOriginDescriptor(value) {
  if (!validOrigin(value)) throw new UsageError("Origin must be one complete descriptor");
  return Object.fromEntries(Object.keys(ORIGIN_LIMITS).map((key) => [key,value[key].trim()]));
}

export function normalizeLifecycleIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "provider,runId"
    || typeof value.provider !== "string" || !LIFECYCLE_PROVIDER.test(value.provider)
    || typeof value.runId !== "string" || !LIFECYCLE_RUN_ID.test(value.runId)) {
    throw new UsageError("Lifecycle identity must contain one bounded provider and opaque runId");
  }
  return { provider: value.provider,runId: value.runId };
}

export async function readPrivateOriginFile(path,{
  lstatImpl = lstat,
  readFileImpl = readFile,
  platform = process.platform,
  uid = process.getuid?.(),
} = {}) {
  if (typeof path !== "string" || !path.trim()) throw new UsageError("--origin-file requires a path");
  let info;
  try {
    info = await lstatImpl(path);
  } catch {
    throw new UsageError("Unable to read the private origin file");
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new UsageError("Origin file must be a regular file, not a link");
  }
  if (platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new UsageError("Origin file must have mode 0600");
  }
  if (platform !== "win32" && uid !== undefined && info.uid !== uid) {
    throw new UsageError("Origin file must be owned by the current user");
  }
  if (info.size > MAX_ORIGIN_FILE_BYTES) throw new UsageError("Origin file is too large");
  let parsed;
  try {
    parsed = JSON.parse(await readFileImpl(path,"utf8"));
  } catch {
    throw new UsageError("Origin file must contain valid JSON");
  }
  const origin = parsed?.origin ?? parsed;
  try {
    return normalizeOriginDescriptor(origin);
  } catch {
    throw new UsageError("Origin file must contain one complete origin descriptor");
  }
}
