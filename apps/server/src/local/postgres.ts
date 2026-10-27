import { execFile, spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import {
  executable, isWindows, portFree, postgresBin, secretPath, socketUrl, windowsBaseEnvironment, type LocalConfig, type LocalLayout,
} from "./layout.js";

const run = promisify(execFile);

/**
 * The attributes compose's database-role-bootstrap gives relo_runtime (deploy/bootstrap-runtime-role.sh). Migration
 * 0014 creates the role NOLOGIN; this is the one statement that lets it log in. A test pins the two to the same list.
 */
export const RUNTIME_ROLE_ATTRIBUTES = "LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";

const pgEnv = (platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv =>
  isWindows(platform) ? { ...windowsBaseEnvironment(), LANG: "C", LC_ALL: "C" } : { ...process.env, LANG: "C", LC_ALL: "C" };

/** A PostgreSQL tool run to completion (windowsHide: a console-less app must not flash a console window). */
const tool = (bin: string, name: string, args: string[]) =>
  run(executable(bin, name), args, { env: pgEnv(), windowsHide: true });

export async function isInitialised(layout: LocalLayout): Promise<boolean> {
  try { await access(path.join(layout.db, "PG_VERSION")); return true; } catch { return false; }
}

/** The data folder's state: nothing there, an empty folder (both safe to initdb into), a database, or something else. */
export async function databaseState(layout: LocalLayout): Promise<"missing" | "empty" | "initialised" | "unknown"> {
  if (await isInitialised(layout)) return "initialised";
  try { return (await readdir(layout.db)).length === 0 ? "empty" : "unknown"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}

/** The data was made by another PostgreSQL major than the bundled one: it isn't ours to open or to touch. */
export class DatabaseVersionError extends Error {
  constructor(readonly dataMajor: number, readonly bundledMajor: number) {
    super("This Relo data was made by a newer or older database; Relo can't open it");
    this.name = "DatabaseVersionError";
  }
}

/** The major in `postgres --version` ("postgres (PostgreSQL) 17.2 ..."), or null. */
export function parsePostgresMajor(text: string): number | null {
  const match = /\b(\d+)(?:\.\d+)*\b/.exec(text.replace(/^[^\d]*/, ""));
  return match ? Number(match[1]) : null;
}

export async function bundledMajor(bin = postgresBin()): Promise<number> {
  const { stdout } = await tool(bin, "postgres", ["--version"]);
  const major = parsePostgresMajor(stdout);
  if (major === null) throw new Error(`can't read the bundled PostgreSQL's version from "${stdout.trim()}"`);
  return major;
}

/** Throws DatabaseVersionError when db/PG_VERSION names a different major than the bundled binaries. */
export async function assertCompatible(layout: LocalLayout, bin = postgresBin()): Promise<void> {
  const dataMajor = parsePostgresMajor(await readFile(path.join(layout.db, "PG_VERSION"), "utf8"));
  const bundled = await bundledMajor(bin);
  if (dataMajor !== bundled) throw new DatabaseVersionError(dataMajor ?? 0, bundled);
}

/** PostgreSQL refuses to run with an administrator's token (an elevated window, "Run as administrator"). */
export class ElevatedError extends Error {
  constructor() {
    super("Relo's database can't run from an administrator (elevated) session: PostgreSQL refuses to start with administrator rights. Start Relo from a normal window, not \"Run as administrator\"");
    this.name = "ElevatedError";
  }
}

/** The High mandatory integrity level's SID: present in `whoami /groups` exactly when the token is elevated. */
const HIGH_INTEGRITY_SID = "S-1-16-12288";
const SYSTEM_INTEGRITY_SID = "S-1-16-16384";

export async function isElevated(
  platform: NodeJS.Platform = process.platform,
  whoami: () => Promise<string> = async () => (await run("whoami", ["/groups", "/fo", "csv", "/nh"], { windowsHide: true })).stdout,
): Promise<boolean> {
  if (!isWindows(platform)) return false;
  try {
    const groups = await whoami();
    return groups.includes(HIGH_INTEGRITY_SID) || groups.includes(SYSTEM_INTEGRITY_SID);
  } catch { return false; }
}

export async function assertNotElevated(platform: NodeJS.Platform = process.platform, whoami?: () => Promise<string>): Promise<void> {
  if (await isElevated(platform, whoami)) throw new ElevatedError();
}

/**
 * initdb in the C locale with scram auth; the superuser is relo, with the generated password. Only into a folder that
 * is missing or empty: data is never wiped to make room (a folder with files but no PG_VERSION is somebody's, or a
 * damaged install, and is left for a person to look at).
 */
export async function initialise(layout: LocalLayout, bin = postgresBin()): Promise<void> {
  const state = await databaseState(layout);
  if (state === "initialised") return;
  if (state === "unknown") {
    throw new Error(`${layout.db} has files but no database in it: Relo won't overwrite it. Move it aside to start fresh`);
  }
  await mkdir(layout.db, { recursive: true, mode: 0o700 });
  await tool(bin, "initdb", [
    "-D", layout.db, "-U", "relo", "--auth=scram-sha-256", `--pwfile=${secretPath(layout, "postgres-password")}`,
    "--locale=C", "--encoding=UTF8",
  ]);
  await writeFile(path.join(layout.db, "postgresql.conf"), localConfiguration(layout), { flag: "a" });
}

/** What Relo appends to postgresql.conf: a socket in the 0700 run directory, or (Windows) loopback TCP only. */
export function localConfiguration(layout: LocalLayout): string {
  return layout.transport === "tcp"
    ? "\n# Relo local mode\nlisten_addresses = '127.0.0.1'\n"
    : "\n# Relo local mode\nlisten_addresses = ''\nunix_socket_permissions = 0700\n";
}

/** pg_ctl's arguments to start the server on `port` (the socket's name on POSIX, the loopback TCP port on Windows). */
export function startArguments(layout: LocalLayout, port: number): string[] {
  const options = layout.transport === "tcp" ? `-p ${port} -c listen_addresses=127.0.0.1` : `-k '${layout.socketDir}' -p ${port}`;
  return ["-D", layout.db, "-l", path.join(layout.logs, "postgres.log"), "-w", "-t", "60", "-o", options, "start"];
}

export async function start(layout: LocalLayout, port: number, bin = postgresBin()): Promise<void> {
  const args = startArguments(layout, port);
  if (layout.transport !== "tcp") {
    await tool(bin, "pg_ctl", args);
    return;
  }
  // The postmaster inherits pg_ctl's stdio pipes on Windows, so an execFile that collects them never sees them close:
  // start with nothing attached and wait for pg_ctl itself (-w returns once the server accepts connections).
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable(bin, "pg_ctl"), args, { env: pgEnv(), stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve()
      : reject(new Error(`pg_ctl couldn't start PostgreSQL (exit ${code}); see ${path.join(layout.logs, "postgres.log")}`)));
  });
}

export async function stop(layout: LocalLayout, bin = postgresBin()): Promise<void> {
  await tool(bin, "pg_ctl", ["-D", layout.db, "-m", "fast", "-w", "-t", "60", "stop"])
    .catch(async (error: unknown) => { if (await running(layout, bin)) throw error; });
}

export async function running(layout: LocalLayout, bin = postgresBin()): Promise<boolean> {
  try {
    await tool(bin, "pg_ctl", ["-D", layout.db, "status"]);
    return true;
  } catch { return false; }
}

/** The pid and port in data/postmaster.pid (line 1 and 4) when that process is alive: a server that outlived its supervisor. */
export async function livePostmaster(layout: LocalLayout, alive: (pid: number) => boolean = processAlive): Promise<{ pid: number; port: number } | null> {
  try {
    const lines = (await readFile(path.join(layout.db, "postmaster.pid"), "utf8")).split(/\r?\n/);
    const pid = Number(lines[0]);
    const port = Number(lines[3]);
    return Number.isInteger(pid) && pid > 0 && Number.isInteger(port) && port > 0 && alive(pid) ? { pid, port } : null;
  } catch { return null; }
}

/**
 * Windows: the loopback port PostgreSQL is on. A server that outlived its supervisor (a killed parent leaves it
 * running) is adopted on the port it already has; else the stored port while it's free; else the next free one.
 */
export async function chooseDatabasePort(
  layout: LocalLayout, config: LocalConfig, alive?: (pid: number) => boolean, free: (port: number) => Promise<boolean> = portFree,
): Promise<number> {
  const live = await livePostmaster(layout, alive);
  if (live) return live.port;
  if (config.dbPort && config.dbPort !== config.port && await free(config.dbPort)) return config.dbPort;
  for (let port = config.port + 1; port < config.port + 100; port++) if (await free(port)) return port;
  throw new Error("no free port for the database");
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Creates the relo database when it is missing, as the compose postgres service does with POSTGRES_DB. */
export async function ensureDatabase(layout: LocalLayout, port: number, superuserPassword: string): Promise<void> {
  const client = new pg.Client(socketUrl(layout, port, "relo", superuserPassword, "postgres"));
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname='relo'");
    if (!exists.rowCount) await client.query("CREATE DATABASE relo");
  } finally { await client.end(); }
}

/** Gives relo_runtime its login and password. Run after every migrate, as compose does on every start. */
export async function grantRuntimeRole(db: pg.Pool | pg.Client, runtimePassword: string): Promise<void> {
  await db.query(`ALTER ROLE relo_runtime ${RUNTIME_ROLE_ATTRIBUTES} PASSWORD ${pg.escapeLiteral(runtimePassword)}`);
}
