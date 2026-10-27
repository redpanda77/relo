import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local mode (plan 16): one Mac runs the server under a LaunchAgent. The data root holds what lives across versions;
 * the install (the version the agent runs) holds the code. Everything here is the one place those paths are named.
 */
export type LocalLayout = {
  /** How PostgreSQL is reached: a Unix socket (macOS, Linux), or loopback TCP on its own port (Windows). */
  transport: "socket" | "tcp";
  root: string;
  db: string;
  run: string;
  /** Where PostgreSQL's socket lives: `run`, or a short per-user folder when `run` would pass the socket path limit. */
  socketDir: string;
  secrets: string;
  logs: string;
  backups: string;
  config: string;
};

/**
 * config.json, which Relo for Mac re-reads: the API's port (it can change when another macOS user holds it), the
 * owner's handle, this install's random `instance` id (so the app knows it talks to its own server) and the release
 * that last started successfully (a different one means a backup before the migrations).
 */
export type LocalConfig = {
  port: number; handle: string; instance: string; release: string | null;
  /** Windows only: the loopback port PostgreSQL listens on (a Unix socket needs none, so macOS never sets it). */
  dbPort?: number;
};

export const isWindows = (platform: NodeJS.Platform = process.platform) => platform === "win32";

/** The port PostgreSQL is reached on: its own on loopback TCP, else the API's port, which only names the socket file. */
export const databasePort = (layout: LocalLayout, config: LocalConfig) => layout.transport === "tcp" ? (config.dbPort ?? config.port + 1) : config.port;

/** The data root when --root is omitted: %LOCALAPPDATA%\Relo\server on Windows; elsewhere the caller must say. */
export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (!isWindows(platform)) return null;
  const base = env.LOCALAPPDATA || (env.USERPROFILE ? path.win32.join(env.USERPROFILE, "AppData", "Local") : null);
  return base ? path.win32.join(base, "Relo", "server") : null;
}

/** `name` as the platform's executable file: `postgres` is `postgres.exe` on Windows. */
export const executable = (dir: string, name: string, platform: NodeJS.Platform = process.platform) =>
  (isWindows(platform) ? path.win32 : path).join(dir, isWindows(platform) ? `${name}.exe` : name);

/**
 * The name of the supervisor's stop channel on Windows, which has no SIGTERM: a named pipe derived from the data root
 * (FNV-1a over the lower-cased path), so the launcher and the app find it without reading anything. It also makes a
 * second supervisor on the same root fail to start. The Rust launcher computes the same name (a test pins both).
 */
export function controlPipeName(root: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(path.win32.normalize(root).replace(/[\\/]+$/, "").toLowerCase(), "utf8")) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `\\\\.\\pipe\\relo-local-${hash.toString(16).padStart(16, "0")}`;
}

/** macOS caps a Unix socket path at 104 bytes, the terminating NUL included. */
export const SOCKET_PATH_LIMIT = 103;
export const DEFAULT_LOCAL_PORT = 8187;
export const LOCAL_OWNER_EMAIL = "owner@relo.local";

/** The widest port, so the fallback decision never depends on which port the install ends up with. */
const WIDEST_PORT = 65535;
const shortSocketDir = (uid: number) => `/tmp/relo-${uid}`;

export function localLayout(root: string, uid = userInfo().uid, platform: NodeJS.Platform = process.platform): LocalLayout {
  const windows = isWindows(platform);
  const p = windows ? path.win32 : path;
  const absolute = p.resolve(root);
  const run = p.join(absolute, "run");
  const fits = windows || Buffer.byteLength(p.join(run, `.s.PGSQL.${WIDEST_PORT}`)) <= SOCKET_PATH_LIMIT;
  return {
    transport: windows ? "tcp" : "socket",
    root: absolute,
    db: p.join(absolute, "db"),
    run,
    socketDir: fits ? run : shortSocketDir(uid),
    secrets: p.join(absolute, "secrets"),
    logs: p.join(absolute, "logs"),
    backups: p.join(absolute, "backups"),
    config: p.join(absolute, "config.json"),
  };
}

export const socketPath = (layout: LocalLayout, port: number) => path.join(layout.socketDir, `.s.PGSQL.${port}`);

/** Null when the socket path fits (a long data root already uses the short per-user folder), else why not. */
export function socketPathProblem(layout: LocalLayout, port: number): string | null {
  if (layout.transport === "tcp") return null;
  const length = Buffer.byteLength(socketPath(layout, port));
  return length <= SOCKET_PATH_LIMIT ? null
    : `the database socket path would be ${length} bytes, over macOS's ${SOCKET_PATH_LIMIT}: install under a shorter folder`;
}

/** Where the install's PostgreSQL binaries are: beside the server in the bundle, or RELO_POSTGRES_BIN. */
export function postgresBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RELO_POSTGRES_BIN) return path.resolve(env.RELO_POSTGRES_BIN);
  // dist/local/layout.js → <install>/server/dist/local → <install>/postgres/bin
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../postgres/bin");
}

export const serverDist = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function ensureLayout(layout: LocalLayout): Promise<void> {
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  for (const dir of [layout.run, layout.secrets, layout.backups]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  await mkdir(layout.logs, { recursive: true, mode: 0o700 });
  if (layout.socketDir !== layout.run) await ensureShortSocketDir(layout.socketDir);
}

/**
 * The short socket folder lives in the shared /tmp, so it is ours only if we made it: a real directory (never a
 * symlink), owned by this user, owner-only. Anything else is refused, never used.
 */
async function ensureShortSocketDir(dir: string, uid = userInfo().uid): Promise<void> {
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) {
    throw new Error(`${dir} isn't a folder of this user: remove it and start Relo again`);
  }
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

export async function readLocalConfig(layout: LocalLayout): Promise<LocalConfig> {
  const raw = JSON.parse(await readFile(layout.config, "utf8")) as Partial<LocalConfig>;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`config.json has no valid port`);
  return {
    port,
    handle: typeof raw.handle === "string" && raw.handle ? raw.handle : "owner",
    // An install made before these fields existed gets them from the supervisor's next start.
    instance: typeof raw.instance === "string" ? raw.instance : "",
    release: typeof raw.release === "string" && raw.release ? raw.release : null,
    ...(Number.isInteger(raw.dbPort) && raw.dbPort! >= 1024 && raw.dbPort! <= 65535 ? { dbPort: raw.dbPort } : {}),
  };
}

/** Written whole and renamed into place, so the app, which re-reads it, never sees half a file. */
export async function writeLocalConfig(layout: LocalLayout, config: LocalConfig): Promise<void> {
  const temporary = `${layout.config}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, layout.config);
}

export const newInstanceId = () => randomBytes(16).toString("hex");

/** The four secrets compose's init-secrets.sh writes, plus the owner's password: made once, owner-only. */
export const SECRET_NAMES = ["postgres-password", "runtime-password", "auth-secret", "bootstrap-token", "owner-password"] as const;
export type SecretName = typeof SECRET_NAMES[number];

export const secretPath = (layout: LocalLayout, name: SecretName) => path.join(layout.secrets, name);

export async function ensureSecrets(layout: LocalLayout): Promise<Record<SecretName, string>> {
  const values = {} as Record<SecretName, string>;
  for (const name of SECRET_NAMES) {
    const file = secretPath(layout, name);
    let value: string | undefined;
    try {
      const info = await stat(file);
      if (!isWindows() && (info.mode & 0o077) !== 0) await chmod(file, 0o600);
      value = (await readFile(file, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!value) {
      value = randomBytes(32).toString("base64url");
      await writeFile(file, `${value}\n`, { mode: 0o600, flag: "w" });
    }
    values[name] = value;
  }
  return values;
}

/**
 * A pg connection string: over the install's socket (the host is the socket directory, percent-encoded), or on
 * Windows to 127.0.0.1 and the database's own port (callers pass databasePort(), the API's port elsewhere).
 */
export function socketUrl(layout: LocalLayout, port: number, user: string, password: string, database: string): string {
  if (layout.transport === "tcp") return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${encodeURIComponent(layout.socketDir)}:${port}/${database}`;
}

/** What a Windows child needs of the user's environment: Node and PostgreSQL fail to start without SystemRoot, and TEMP and the profile are where they write. */
export function windowsBaseEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "SystemDrive", "windir", "ComSpec", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "ProgramData"]) {
    const value = base[name] ?? base[name.toUpperCase()];
    if (value) out[name] = value;
  }
  out.PATH = base.PATH ?? base.Path ?? `${out.SystemRoot ?? "C:\\Windows"}\\System32`;
  return out;
}

/** The environment the API and the worker run with: the same for both, APP_URL included (the worker needs it). */
export function childEnvironment(
  layout: LocalLayout, config: LocalConfig, secrets: Record<SecretName, string>, base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...(layout.transport === "tcp" ? windowsBaseEnvironment(base) : { PATH: base.PATH ?? "/usr/bin:/bin", HOME: base.HOME }),
    LANG: "C",
    LC_ALL: "C",
    NODE_ENV: "production",
    DATABASE_URL: socketUrl(layout, databasePort(layout, config), "relo_runtime", secrets["runtime-password"], "relo"),
    HOST: "127.0.0.1",
    PORT: String(config.port),
    APP_URL: `http://127.0.0.1:${config.port}`,
    BETTER_AUTH_SECRET_FILE: secretPath(layout, "auth-secret"),
    BOOTSTRAP_OWNER_HANDLE: config.handle,
    BOOTSTRAP_OWNER_TOKEN_FILE: secretPath(layout, "bootstrap-token"),
    APNS_MODE: "disabled",
    RELO_CONTENT_RETENTION_HOURS: "10",
    RELO_WORKER_READY_FILE: path.join(layout.run, "worker-ready"),
    LOG_LEVEL: base.LOG_LEVEL ?? "info",
    RELO_LOCAL_MODE: "1",
    // /health/ready reports it, so the app knows the server on this port is its own.
    ...(config.instance ? { RELO_LOCAL_INSTANCE: config.instance } : {}),
    // The app's version, passed by its launcher: /health/ready reports it and the worker records it.
    ...(base.RELO_RELEASE_IDENTITY ? { RELO_RELEASE_IDENTITY: base.RELO_RELEASE_IDENTITY } : {}),
  };
}

/** Whether nothing listens on 127.0.0.1:port. */
export const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const server = createServer().once("error", () => resolve(false));
  server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
});

/** The first port from `from` that nothing on 127.0.0.1 listens on (stored by the caller). */
export async function freePort(from = DEFAULT_LOCAL_PORT, tries = 50): Promise<number> {
  for (let port = from; port < from + tries; port++) if (await portFree(port)) return port;
  throw new Error(`no free port between ${from} and ${from + tries - 1}`);
}

/** The `instance` a Relo server on 127.0.0.1:port reports at /health/ready, or null when it isn't one (or doesn't answer). */
export async function instanceOnPort(port: number, timeoutMs = 2_000): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json() as { instance?: unknown };
    return typeof body.instance === "string" ? body.instance : null;
  } catch { return null; }
}

/**
 * The port this install serves on: the stored one while it's free or already answers as this install, else the next
 * free one (another macOS user, or a dev server, holds it). `changed` tells the caller to store it.
 */
export async function choosePort(config: LocalConfig): Promise<{ port: number; changed: boolean }> {
  if (await portFree(config.port)) return { port: config.port, changed: false };
  if (config.instance && await instanceOnPort(config.port) === config.instance) return { port: config.port, changed: false };
  return { port: await freePort(config.port + 1), changed: true };
}
