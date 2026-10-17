// A sign-in the owner has not approved yet, kept between `relo auth login --no-wait` and `--wait`.
// It lives beside the config file (mode 0600, folder 0700) because there is no config until sign-in
// succeeds. It holds the device code (a poll secret), so it is never printed, and it is deleted as
// soon as the sign-in succeeds, is denied, or expires.
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_BYTES = 8 * 1024;

export const pendingLoginPath = (configPath) => join(dirname(configPath), "login-pending.json");

const shapeOk = (value) => value && typeof value === "object" && typeof value.deviceCode === "string"
  && typeof value.apiUrl === "string" && typeof value.clientName === "string" && Array.isArray(value.scopes)
  && typeof value.userCode === "string" && typeof value.url === "string"
  && Number.isFinite(value.expiresAtMs) && Number.isFinite(value.intervalSeconds);

/** The stored pending sign-in, or null when none exists or the file is not a private regular file. */
export async function readPendingLogin(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return null;
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) return null;
    const value = JSON.parse(await readFile(path, "utf8"));
    return shapeOk(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writePendingLogin(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.login.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export const clearPendingLogin = (path) => rm(path, { force: true });
