import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
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

export const DEFAULT_PROFILE = "default";
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/u;

export function profileName(value) {
  const name = String(value ?? "").trim();
  if (!PROFILE_NAME.test(name)) {
    throw new UsageError(`Invalid profile name "${name}": use 1-40 letters, digits, "-" or "_".`);
  }
  return name;
}

/** One sign-in (a profile): server, credential, and what the first phone test learned. */
function validateProfileRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError("Relo config must be a JSON object.", { code: "INVALID_CONFIG" });
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new AuthError("Relo config version is not supported.", { code: "INVALID_CONFIG" });
  }
  if (typeof value.token !== "string" || value.token.length < 32) {
    throw new AuthError("Relo config has no valid credential.", { code: "INVALID_CONFIG" });
  }
  const phoneTest = validRecord(value.phoneTest, ["verifiedAt", "deviceId"]);
  const pendingTest = validRecord(value.pendingTest, ["interactionId", "cardId", "startedAt"]);
  return {
    version: 1,
    apiUrl: normalizeApiUrl(value.apiUrl),
    token: value.token,
    principal: typeof value.principal === "object" && value.principal ? value.principal : undefined,
    ...(phoneTest ? { phoneTest } : {}),
    ...(pendingTest ? { pendingTest } : {}),
  };
}

export function validateConfig(value) {
  const profile = validateProfileRecord(value);
  const accounts = validAccounts(value.accounts);
  const computerName = validComputerName(value.computerName);
  return {
    ...profile,
    ...(Object.keys(accounts).length > 0 ? { accounts } : {}),
    ...(computerName ? { computerName } : {}),
  };
}

function validComputerName(value) {
  return typeof value === "string" && value.trim() && Array.from(value.trim()).length <= 120 ? value.trim() : undefined;
}

/**
 * The file on disk: `{version, activeProfile, profiles: {NAME: record}, accounts, computerName}`.
 * A file written before profiles existed is one flat record, read as the profile `default`.
 */
function parseStored(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError("Relo config must be a JSON object.", { code: "INVALID_CONFIG" });
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new AuthError("Relo config version is not supported.", { code: "INVALID_CONFIG" });
  }
  const accounts = validAccounts(value.accounts);
  const computerName = validComputerName(value.computerName);
  let profiles;
  if (value.profiles === undefined) {
    profiles = { [DEFAULT_PROFILE]: validateProfileRecord(value) };
  } else {
    if (!value.profiles || typeof value.profiles !== "object" || Array.isArray(value.profiles)
      || Object.keys(value.profiles).length === 0) {
      throw new AuthError("Relo config has no profiles.", { code: "INVALID_CONFIG" });
    }
    profiles = Object.fromEntries(Object.entries(value.profiles).map(([name, record]) => [profileName(name), validateProfileRecord(record)]));
  }
  const names = Object.keys(profiles);
  const activeProfile = names.includes(value.activeProfile) ? value.activeProfile
    : names.includes(DEFAULT_PROFILE) ? DEFAULT_PROFILE : names[0];
  return { activeProfile, profiles, accounts, ...(computerName ? { computerName } : {}) };
}

function selectProfile(stored, requested) {
  const name = requested === undefined ? stored.activeProfile : profileName(requested);
  const record = stored.profiles[name];
  if (!record) {
    throw new AuthError(`No Relo profile "${name}".`, {
      code: "PROFILE_NOT_FOUND",
      details: { hint: `relo auth login --profile ${name}  (profiles: ${Object.keys(stored.profiles).join(", ")})` },
    });
  }
  return {
    ...record,
    ...(Object.keys(stored.accounts).length > 0 ? { accounts: stored.accounts } : {}),
    ...(stored.computerName ? { computerName: stored.computerName } : {}),
    profile: name,
    activeProfile: stored.activeProfile,
    profiles: Object.keys(stored.profiles),
  };
}

/** A small record of short strings (the first phone test), or undefined when anything is off. */
function validRecord(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = fields.map((field) => [field, value[field]]);
  if (entries.some(([, text]) => typeof text !== "string" || text.length === 0 || text.length > 200)) return undefined;
  return Object.fromEntries(entries);
}

/** Nicknames for the agent accounts on this computer, keyed by the agent's config directory. */
function validAccounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([directory, name]) =>
    directory.length > 0 && directory.length <= 500 && typeof name === "string"
    && name.trim().length > 0 && Array.from(name.trim()).length <= 40).map(([directory, name]) => [directory, name.trim()]));
}

function readStoredSync(path, { platform = process.platform, uid = process.getuid?.() } = {}) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) return {};
    if (platform !== "win32" && ((info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid))) return {};
    return JSON.parse(readFileSync(path, "utf8")) ?? {};
  } catch {
    return {};
  }
}

/**
 * Account nicknames for identity detection. Synchronous and forgiving: a missing, insecure or
 * unreadable config simply has no nicknames. Never reads anything but Relo's own config file.
 */
export function loadAccountsSync(path = configPath(), options) {
  return validAccounts(readStoredSync(path, options).accounts);
}

/** The computer name cached by an earlier command (shared by every profile), or undefined. */
export function loadComputerNameSync(path = configPath(), options) {
  return validComputerName(readStoredSync(path, options).computerName);
}

async function readStored(path, options) {
  const contents = await readSecureContents(path, options);
  if (contents === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new AuthError(`Invalid JSON in ${path}.`, { code: "INVALID_CONFIG" });
  }
  return { stored: parseStored(parsed), revision: digest(contents) };
}

/** The active profile (or `profile`) as one flat config; `profiles` lists every profile name. */
export async function loadConfig(path = configPath(), { platform = process.platform, uid = process.getuid?.(), profile } = {}) {
  const read = await readStored(path, { platform, uid });
  if (read === null) {
    throw new AuthError(`No Relo credential configured at ${path}.`, { code: "CONFIG_NOT_FOUND" });
  }
  return { ...selectProfile(read.stored, profile), path, revision: read.revision };
}

async function commitText(path, text, { platform, uid, expected, beforeCommit }) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(directory, 0o700);
  const temporary = join(directory, `.config.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
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
}

const storedText = (stored) => `${JSON.stringify({
  version: 1,
  activeProfile: stored.activeProfile,
  profiles: stored.profiles,
  ...(Object.keys(stored.accounts ?? {}).length > 0 ? { accounts: stored.accounts } : {}),
  ...(stored.computerName ? { computerName: stored.computerName } : {}),
}, null, 2)}\n`;

/**
 * Stores one profile (config.profile, else the active one, else `default`); every other profile is
 * kept as it is. A file in the old single-record form is rewritten in the profiles form here.
 */
export async function writeConfig(path, config, {
  platform = process.platform,
  uid = process.getuid?.(),
  expectedRevision,
  beforeCommit,
} = {}) {
  const record = validateProfileRecord(config);
  const accounts = config.accounts === undefined ? undefined : validAccounts(config.accounts);
  const expected = expectedRevision === undefined
    ? await configRevision(path, { platform, uid })
    : expectedRevision;
  let existing;
  try { existing = (await readStored(path, { platform, uid }))?.stored; } catch { existing = undefined; }
  const name = config.profile === undefined ? (existing?.activeProfile ?? DEFAULT_PROFILE) : profileName(config.profile);
  const profiles = { ...existing?.profiles, [name]: { ...record, token: config.token } };
  const activeProfile = profiles[config.activeProfile] ? config.activeProfile
    : profiles[existing?.activeProfile] ? existing.activeProfile : name;
  const computerName = validComputerName(config.computerName) ?? existing?.computerName;
  await commitText(path, storedText({ activeProfile, profiles, accounts: accounts ?? existing?.accounts,
    ...(computerName ? { computerName } : {}) }), { platform, uid, expected, beforeCommit });
  return path;
}

/** Makes `name` the active profile. Returns { profile, profiles }. */
export async function switchProfile(path, name, { platform = process.platform, uid = process.getuid?.() } = {}) {
  const wanted = profileName(name);
  const read = await readStored(path, { platform, uid });
  if (read === null) throw new AuthError(`No Relo credential configured at ${path}.`, { code: "CONFIG_NOT_FOUND" });
  const names = Object.keys(read.stored.profiles);
  if (!names.includes(wanted)) {
    throw new UsageError(`No Relo profile "${wanted}".`, { hint: `Profiles: ${names.join(", ")}. New one: relo auth login --profile ${wanted}` });
  }
  if (read.stored.activeProfile !== wanted) {
    await commitText(path, storedText({ ...read.stored, activeProfile: wanted }), { platform, uid, expected: read.revision });
  }
  return { profile: wanted, profiles: names };
}

/** Removes the credential: just `profile` when others remain, else the whole file. */
export async function removeConfig(path, { expectedRevision, profile, platform = process.platform, uid = process.getuid?.() } = {}) {
  try {
    if (expectedRevision !== undefined && await configRevision(path) !== expectedRevision) {
      throw new AuthError("Relo config changed while credentials were being removed.", {
        code: "CONFIGURATION_CHANGED",
      });
    }
    let read;
    try { read = await readStored(path, { platform, uid }); } catch { read = null; }
    const names = read ? Object.keys(read.stored.profiles) : [];
    if (read && names.length > 1) {
      const target = profile ?? read.stored.activeProfile;
      const profiles = Object.fromEntries(Object.entries(read.stored.profiles).filter(([name]) => name !== target));
      const remaining = Object.keys(profiles);
      const activeProfile = remaining.includes(read.stored.activeProfile) ? read.stored.activeProfile
        : remaining.includes(DEFAULT_PROFILE) ? DEFAULT_PROFILE : remaining[0];
      await commitText(path, storedText({ ...read.stored, activeProfile, profiles }), { platform, uid, expected: read.revision });
      return true;
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

/**
 * CI and containers: RELO_TOKEN (with RELO_API_URL) overrides the config file.
 * Environment variables, never flags, so the token stays out of argv and shell history.
 */
export function environmentConfig(env = process.env) {
  if (env.RELO_TOKEN === undefined || env.RELO_TOKEN === "") return null;
  if (!env.RELO_API_URL) {
    throw new AuthError("RELO_TOKEN is set but RELO_API_URL is not.", {
      code: "INVALID_CONFIG",
      details: { hint: "Set RELO_API_URL to your Relo server origin, e.g. https://relo.example.com" },
    });
  }
  return { ...validateConfig({ apiUrl: env.RELO_API_URL, token: env.RELO_TOKEN.trim() }),
    path: null, revision: null, source: "environment" };
}
