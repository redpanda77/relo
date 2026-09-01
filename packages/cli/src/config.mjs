import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AuthError, UsageError } from "./errors.mjs";

const MAX_CONFIG_BYTES = 32 * 1024;

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function readSecureContents(path, { platform = process.platform, uid = process.getuid?.() } = {}) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new AuthError(`Refusing non-regular config file at ${path}.`, { code: "INSECURE_CONFIG" });
  }
  if (platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new AuthError(`Refusing insecure config permissions at ${path}; expected mode 0600.`, { code: "INSECURE_CONFIG" });
  }
  if (platform !== "win32" && uid !== undefined && info.uid !== uid) {
    throw new AuthError(`Refusing config not owned by the current user at ${path}.`, { code: "INSECURE_CONFIG" });
  }
  if (info.size > MAX_CONFIG_BYTES) {
    throw new AuthError(`Refusing oversized config at ${path}.`, { code: "INVALID_CONFIG" });
  }
  return readFile(path, "utf8");
}

export async function configRevision(path = configPath(), options = {}) {
  const contents = await readSecureContents(path, options);
  return contents === null ? null : digest(contents);
}

function isPrivateLocalHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254)
  );
}

export function configPath({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.RELO_CONFIG_PATH) return env.RELO_CONFIG_PATH;
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "relo", "config.json");
  }
  if (platform === "win32") {
    return join(env.APPDATA ?? home, "relo", "config.json");
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "relo", "config.json");
}

export function normalizeApiUrl(value) {
  let apiUrl;
  try {
    apiUrl = new URL(value);
  } catch {
    throw new AuthError("Relo API URL is invalid.", { code: "INVALID_CONFIG" });
  }
  if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && isPrivateLocalHost(apiUrl.hostname))) {
    throw new AuthError("Relo API URL must use HTTPS or private local HTTP.", {
      code: "INSECURE_API_URL",
    });
  }
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash || apiUrl.pathname !== "/") {
    throw new AuthError("Relo API URL must be an origin without credentials, path, query, or fragment.", {
      code: "INVALID_CONFIG",
    });
  }
  return apiUrl.toString().replace(/\/$/, "");
}

export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError("Relo config must be a JSON object.", { code: "INVALID_CONFIG" });
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new AuthError("Relo config version is not supported.", { code: "INVALID_CONFIG" });
  }
  if (typeof value.token !== "string" || value.token.length < 32) {
    throw new AuthError("Relo config has no valid credential.", { code: "INVALID_CONFIG" });
  }
  return {
    version: 1,
    apiUrl: normalizeApiUrl(value.apiUrl),
    token: value.token,
    principal: typeof value.principal === "object" && value.principal ? value.principal : undefined,
  };
}

export async function loadConfig(path = configPath(), { platform = process.platform, uid = process.getuid?.() } = {}) {
  const contents = await readSecureContents(path, { platform, uid });
  if (contents === null) {
    throw new AuthError(`No Relo credential configured at ${path}.`, { code: "CONFIG_NOT_FOUND" });
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new AuthError(`Invalid JSON in ${path}.`, { code: "INVALID_CONFIG" });
  }
  return { ...validateConfig(parsed), path, revision: digest(contents) };
}

export async function writeConfig(path, config, {
  platform = process.platform,
  uid = process.getuid?.(),
  expectedRevision,
  beforeCommit,
} = {}) {
  const validated = validateConfig(config);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(directory, 0o700);
  const temporary = join(directory, `.config.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const expected = expectedRevision === undefined
    ? await configRevision(path, { platform, uid })
    : expectedRevision;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ ...validated, token: config.token }, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (platform !== "win32") await chmod(temporary, 0o600);
    await beforeCommit?.(path);
    if (await configRevision(path, { platform, uid }) !== expected) {
      throw new AuthError("Relo config changed while credentials were being stored.", {
        code: "CONFIGURATION_CHANGED",
      });
    }
    await rename(temporary, path);
    if (platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return path;
}

export async function removeConfig(path, { expectedRevision } = {}) {
  try {
    if (expectedRevision !== undefined && await configRevision(path) !== expectedRevision) {
      throw new AuthError("Relo config changed while credentials were being removed.", {
        code: "CONFIGURATION_CHANGED",
      });
    }
    await rm(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function publicConfig(config) {
  if (!config) throw new UsageError("Config is required");
  return {
    apiUrl: config.apiUrl,
    authenticated: Boolean(config.token),
    principal: config.principal,
    configPath: config.path,
  };
}
