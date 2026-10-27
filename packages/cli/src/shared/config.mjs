import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { chmod, lstat, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { renameWithRetry } from "./atomic-write.mjs";
import { AuthError, UsageError } from "./errors.mjs";
import { ensurePrivateDirectory } from "./private-dir.mjs";
import { isPrivateHost } from "./origin.generated.mjs";

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

/** Is this API URL's host this computer (127.0.0.0/8, localhost, ::1)? Only the host decides; "local" is the account's own mark. */
export function isLoopbackApiUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/u.test(host);
  } catch {
    return false;
  }
}

export function normalizeApiUrl(value) {
  let apiUrl;
  try {
    apiUrl = new URL(value);
  } catch {
    throw new AuthError("Relo API URL is invalid.", { code: "INVALID_CONFIG" });
  }
  if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && isPrivateHost(apiUrl.hostname))) {
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

const DEFAULT_PROFILE = "default";
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/u;

export function profileName(value) {
  const name = String(value ?? "").trim();
  if (!PROFILE_NAME.test(name)) {
    throw new UsageError(`Invalid profile name "${name}": use 1-40 letters, digits, "-" or "_".`);
  }
  return name;
}

/** One sign-in (a profile): server, credential, `local` (an account on the server Relo for Mac hosts: nothing is sealed), and what the first phone test learned. */
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
    ...(value.local === true ? { local: true } : {}),
    ...(phoneTest ? { phoneTest } : {}),
    ...(pendingTest ? { pendingTest } : {}),
  };
}

export function validateConfig(value) {
  const profile = validateProfileRecord(value);
  const accounts = validAccounts(value.accounts);
  const projects = validProjects(value.projects);
  const voices = validVoices(value.voices);
  const computerName = validComputerName(value.computerName);
  return {
    ...profile,
    ...(Object.keys(accounts).length > 0 ? { accounts } : {}),
    ...(Object.keys(projects).length > 0 ? { projects } : {}),
    ...(Object.keys(voices).length > 0 ? { voices } : {}),
    ...(computerName ? { computerName } : {}),
  };
}

function validComputerName(value) {
  return typeof value === "string" && value.trim() && Array.from(value.trim()).length <= 120 ? value.trim() : undefined;
}

/**
 * The file on disk: `{version, activeProfile, profiles: {NAME: record}, accounts, projects, voices, computerName}`.
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
  const projects = validProjects(value.projects);
  const voices = validVoices(value.voices);
  const computerName = validComputerName(value.computerName);
  let profiles;
  if (value.profiles === undefined) {
    profiles = { [DEFAULT_PROFILE]: validateProfileRecord(value) };
  } else {
    if (!value.profiles || typeof value.profiles !== "object" || Array.isArray(value.profiles)) {
      throw new AuthError("Relo config has no profiles.", { code: "INVALID_CONFIG" });
    }
    profiles = Object.fromEntries(Object.entries(value.profiles).map(([name, record]) => [profileName(name), validateProfileRecord(record)]));
  }
  const names = Object.keys(profiles);
  const activeProfile = names.includes(value.activeProfile) ? value.activeProfile
    : names.includes(DEFAULT_PROFILE) ? DEFAULT_PROFILE : names[0];
  // A file whose last profile was removed keeps its other fields: no profiles, no active one.
  return { activeProfile, profiles, accounts, projects, voices, ...(computerName ? { computerName } : {}) };
}

function selectProfile(stored, requested, path) {
  if (Object.keys(stored.profiles).length === 0) {
    throw new AuthError(`No Relo credential configured at ${path}.`, { code: "CONFIG_NOT_FOUND" });
  }
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
    ...(Object.keys(stored.projects).length > 0 ? { projects: stored.projects } : {}),
    ...(Object.keys(stored.voices ?? {}).length > 0 ? { voices: stored.voices } : {}),
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

/** Project names for folders on this computer (`relo project NAME`), keyed by the folder's absolute path. */
/** How much Relo for Mac may say of work started in a place (ADR 0015): folder → off|brief|full|verbose; "*" is the default. */
export const VOICE_LEVELS = Object.freeze(["off", "brief", "full", "verbose"]);

function validVoices(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([place, level]) =>
    place.length > 0 && place.length <= 1000 && VOICE_LEVELS.includes(level)));
}

function validProjects(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([directory, name]) =>
    directory.length > 0 && directory.length <= 1000 && typeof name === "string"
    && name.trim().length > 0 && Array.from(name.trim()).length <= 120).map(([directory, name]) => [directory, name.trim()]));
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

/** Voice levels for folders (and "*"), read the same forgiving way as the project names. */
export function loadVoicesSync(path = configPath(), options) {
  return validVoices(readStoredSync(path, options).voices);
}

/** Project names for folders, read the same forgiving way as the account nicknames. */
export function loadProjectsSync(path = configPath(), options) {
  return validProjects(readStoredSync(path, options).projects);
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
export async function loadConfig(path = configPath(), { platform = process.platform, uid = process.getuid?.(), profile, env = process.env, home = homedir() } = {}) {
  const read = await readStored(path, { platform, uid });
  if (read === null) {
    throw new AuthError(`No Relo credential configured at ${path}.`, { code: "CONFIG_NOT_FOUND" });
  }
  const selected = selectProfile(read.stored, profile, path);
  return { ...selected, apiUrl: followLocalServerPort(selected, { env, home, platform }), path, revision: read.revision };
}

/** Where Relo for Mac keeps its local server's settings (the port it listens on). RELO_LOCAL_SERVER_CONFIG overrides it (tests). */
export function localServerConfigPath({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (env.RELO_LOCAL_SERVER_CONFIG) return env.RELO_LOCAL_SERVER_CONFIG;
  return platform === "darwin" ? join(home, "Library", "Application Support", "Relo", "server", "config.json") : undefined;
}

/**
 * The local server moves port between launches: a `local` profile on loopback uses the port its server's own config
 * names now, keeping the stored host. One small file read; anything unreadable keeps the stored URL.
 */
function followLocalServerPort(config, options) {
  if (config.local !== true || !isLoopbackApiUrl(config.apiUrl)) return config.apiUrl;
  const file = localServerConfigPath(options);
  if (!file) return config.apiUrl;
  try {
    const port = JSON.parse(readFileSync(file, "utf8"))?.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return config.apiUrl;
    const url = new URL(config.apiUrl);
    if (url.port === String(port)) return config.apiUrl;
    url.port = String(port);
    return url.toString().replace(/\/$/, "");
  } catch {
    return config.apiUrl;
  }
}

async function commitText(path, text, { platform, uid, expected, beforeCommit }) {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory, { platform });
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
    await renameWithRetry(temporary, path, { platform });
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
  ...(Object.keys(stored.projects ?? {}).length > 0 ? { projects: stored.projects } : {}),
  ...(Object.keys(stored.voices ?? {}).length > 0 ? { voices: stored.voices } : {}),
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
  const projects = config.projects === undefined ? undefined : validProjects(config.projects);
  const voices = config.voices === undefined ? undefined : validVoices(config.voices);
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
    projects: projects ?? existing?.projects, voices: voices ?? existing?.voices, ...(computerName ? { computerName } : {}) }), { platform, uid, expected, beforeCommit });
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

/** Removes the credential: just `profile` (or the active one); the file stays, with its other fields, even when no profile is left. */
export async function removeConfig(path, { expectedRevision, profile, platform = process.platform, uid = process.getuid?.() } = {}) {
  try {
    if (expectedRevision !== undefined && await configRevision(path) !== expectedRevision) {
      throw new AuthError("Relo config changed while credentials were being removed.", {
        code: "CONFIGURATION_CHANGED",
      });
    }
    let read;
    try { read = await readStored(path, { platform, uid }); } catch { read = null; }
    if (read) {
      const target = profile ?? read.stored.activeProfile;
      if (!Object.hasOwn(read.stored.profiles, target)) return false;
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
