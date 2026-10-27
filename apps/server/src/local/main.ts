import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createInviteSchema } from "../computer-invites.js";
import { createAuthDatabase, createDatabase } from "../db.js";
import { migrate } from "../migrate.js";
import { backupDatabase } from "./backup.js";
import {
  childEnvironment, choosePort, controlPipeName, databasePort, defaultDataRoot, type SecretName, ensureLayout, ensureSecrets, LOCAL_OWNER_EMAIL,
  localLayout, newInstanceId, readLocalConfig,
  serverDist, freePort, socketPathProblem, socketUrl, writeLocalConfig, type LocalConfig, type LocalLayout,
} from "./layout.js";
import { listenForStop, requestStop } from "./control.js";
import { ensureLocalOwner, localInvite } from "./owner.js";
import * as postgres from "./postgres.js";
import { createShutdown } from "./shutdown.js";

/**
 * Relo's local-mode supervisor (plan 16), run by the LaunchAgent and by `relo local`:
 *   run      start PostgreSQL, migrate, make sure the owner exists, then run the API and the worker until SIGTERM
 *   prepare  the first-run half of run (layout, secrets, database, owner) without serving; the installer's first step
 *   invite   print a one-time computer invite as JSON (needs prepare)
 *   owner    print the owner's sign-in email and password file as JSON
 *   stop     (Windows) ask the running supervisor to stop gracefully over its pipe, and wait for it
 * Every command takes --root (the data root; on Windows it defaults to %LOCALAPPDATA%\Relo\server). Nothing here
 * listens beyond 127.0.0.1. On Windows PostgreSQL is reached over loopback TCP on config.json's dbPort, and the
 * stop channel is a named pipe or the launcher's stdin (--stop-on-stdin-close): see apps/windows/server-launcher/README.md.
 */
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string" },
    port: { type: "string" },
    level: { type: "string" },
    approvals: { type: "boolean" },
    agent: { type: "string", multiple: true },
    "mac-app": { type: "boolean" },
    "stop-on-stdin-close": { type: "boolean" },
  },
  strict: true,
});
const command = positionals[0] ?? "run";
const root = values.root ?? defaultDataRoot();
if (!root) fail("--root is required");
const layout = localLayout(root);
const windows = layout.transport === "tcp";

function fail(message: string): never {
  console.error(`relo local: ${message}`);
  process.exit(1);
}

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

/** The app's version, passed by its launcher; a different one than config.json records means a backup before migrating. */
const currentRelease = () => process.env.RELO_RELEASE_IDENTITY || null;

/** The config, made (first run) or completed (an install from before the instance id) and put right about the port. */
async function readyConfig(root: LocalLayout): Promise<{ config: LocalConfig; portMoved: boolean }> {
  let config: LocalConfig;
  let changed = false;
  let portMoved = false;
  try {
    config = await readLocalConfig(root);
    if (!config.instance) { config = { ...config, instance: newInstanceId() }; changed = true; }
    // Two macOS users, or a dev server, can hold the stored port: take the next free one and say so. The app re-reads it.
    const chosen = await choosePort(config);
    if (chosen.changed) {
      log("port_changed", { from: config.port, to: chosen.port, reason: "the stored port is held by another process" });
      config = { ...config, port: chosen.port };
      changed = true;
      portMoved = true;
    }
  } catch {
    config = { port: values.port ? Number(values.port) : await freePort(), handle: "owner", instance: newInstanceId(), release: null };
    changed = true;
  }
  if (windows) {
    // PostgreSQL has a TCP port of its own on Windows: a server left running by a killed supervisor keeps the one it has.
    const dbPort = await postgres.chooseDatabasePort(root, config);
    if (dbPort !== config.dbPort) { config = { ...config, dbPort }; changed = true; }
  }
  if (changed) await writeLocalConfig(root, config);
  // The database's port doesn't follow the API's on Windows, so a moved API port needs no PostgreSQL restart there.
  return { config, portMoved: portMoved && !windows };
}

/** Times one start phase and logs it (`phase_ms`), so a slow start says where the time went. */
async function phase<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await work(); }
  finally { log("phase_ms", { phase: name, ms: Math.round(performance.now() - started) }); }
}

/**
 * Brings PostgreSQL up, and the data to this release. The once-per-release work (the version check, migrations, the
 * runtime role's login, the owner) runs on a first run and when config.json's recorded release differs from this one;
 * a start of the same release only starts PostgreSQL. A release is recorded only after all of it succeeded.
 */
async function prepare(root: LocalLayout, early?: (config: LocalConfig, secrets: Record<SecretName, string>) => void) {
  await postgres.assertNotElevated();
  await ensureLayout(root);
  const ready = await readyConfig(root);
  const portMoved = ready.portMoved;
  let config = ready.config;
  const problem = socketPathProblem(root, config.port);
  if (problem) fail(problem);
  const secrets = await ensureSecrets(root);
  const freshDatabase = await postgres.databaseState(root) !== "initialised";
  const release = currentRelease();
  // Without a release identity (a dev run) every start does the full setup.
  const needsSetup = freshDatabase || !release || config.release !== release;
  if (freshDatabase) {
    log("database_initialising");
    await phase("initdb", () => postgres.initialise(root));
  }
  if (needsSetup) {
    // Before anything touches the data (stop, copy, start): a database from another PostgreSQL major isn't opened.
    await phase("assert_compatible", () => postgres.assertCompatible(root)).catch((error: unknown) => {
      if (error instanceof postgres.DatabaseVersionError) {
        log("database_version_mismatch", { dataMajor: error.dataMajor, bundledMajor: error.bundledMajor, message: error.message });
      }
      throw error;
    });
  }
  // A port that moved leaves a running PostgreSQL on the old socket: stop it, it starts again on the new one.
  // A new release on an existing database: copy it, stopped, before the migrations (an install that never recorded
  // its release is "unknown").
  const backupFor = release && !freshDatabase && config.release !== release ? (config.release ?? "unknown") : null;
  // A same-release start has nothing to wait for but PostgreSQL itself, and the API and the worker spend their first
  // few hundred milliseconds loading code: they start now, and PostgreSQL is up before they first connect.
  // (Windows starts them after PostgreSQL: its start takes seconds under antivirus, and children that connect first just crash and back off.)
  if (!needsSetup && !portMoved && !windows) early?.(config, secrets);
  let isRunning = await phase("pg_status", () => postgres.running(root));
  if ((portMoved || backupFor) && isRunning) { await phase("pg_stop", () => postgres.stop(root)); isRunning = false; }
  let backup: string | null = null;
  if (backupFor) {
    backup = await phase("backup", () => backupDatabase(root, backupFor));
    log("database_backed_up", { from: backupFor, to: release, backup });
  }
  const dbPort = databasePort(root, config);
  if (isRunning) log("postgres_adopted", { port: dbPort });
  else await phase("pg_start", () => postgres.start(root, dbPort));
  if (!needsSetup) return { config, secrets, warm: true };
  await phase("ensure_database", () => postgres.ensureDatabase(root, dbPort, secrets["postgres-password"]));
  const superuser = socketUrl(root, dbPort, "relo", secrets["postgres-password"], "relo");
  const db = createDatabase(superuser);
  const authDb = createAuthDatabase(superuser);
  try {
    await phase("migrate", () => migrate(db));
    await phase("runtime_role", () => postgres.grantRuntimeRole(db, secrets["runtime-password"]));
    const owner = await phase("owner", () => ensureLocalOwner(db, authDb, {
      handle: config.handle, bootstrapToken: secrets["bootstrap-token"], password: secrets["owner-password"],
      name: userInfo().username || "Owner", appUrl: `http://127.0.0.1:${config.port}`, authSecret: secrets["auth-secret"],
    }));
    if (owner === "claimed") log("owner_claimed", { email: LOCAL_OWNER_EMAIL });
  } catch (error) {
    // The data stays as the failed migration left it, PostgreSQL stops, and the backup (when there is one) is kept.
    log("migration_failed", { message: error instanceof Error ? error.message : String(error), ...(backup ? { backup, restore: "stop Relo, replace db/ with this backup" } : {}) });
    await postgres.stop(root).catch(() => undefined);
    throw error;
  } finally {
    await Promise.all([db.end(), authDb.end()]);
  }
  // The release that started successfully: the next release backs up from here and skips this setup.
  if (release && config.release !== release) {
    config = { ...config, release };
    await writeLocalConfig(root, config);
  }
  return { config, secrets, warm: false };
}

/** Runs one child and restarts it with backoff; a child that stayed up a minute starts again from a short delay. */
function supervise(name: string, script: string, env: NodeJS.ProcessEnv, stopping: () => boolean): { child: () => ChildProcess | undefined } {
  let current: ChildProcess | undefined;
  let delay = 1_000;
  const launch = () => {
    const startedAt = Date.now();
    // Windows: through child.js, whose IPC channel is the graceful stop (there is no SIGTERM); no console window.
    current = windows
      ? spawn(process.execPath, [path.join(serverDist(), "local", "child.js"), path.join(serverDist(), script)],
        { env, stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true })
      : spawn(process.execPath, [path.join(serverDist(), script)], { env, stdio: "inherit" });
    current.on("exit", (code, signal) => {
      if (stopping()) return;
      delay = Date.now() - startedAt > 60_000 ? 1_000 : Math.min(delay * 2, 30_000);
      log("child_exited", { name, code, signal, restartInMs: delay });
      setTimeout(launch, delay);
    });
  };
  launch();
  return { child: () => current };
}

async function runServer() {
  let api: ReturnType<typeof supervise> | undefined;
  let worker: ReturnType<typeof supervise> | undefined;
  // Registered before prepare: launchd's SIGTERM during a slow start still stops PostgreSQL instead of orphaning it.
  const stop = createShutdown({
    children: () => [api?.child(), worker?.child()],
    stopPostgres: () => postgres.stop(layout),
    cleanup: () => rm(path.join(layout.run, "supervisor.json"), { force: true }),
    exit: (code) => process.exit(code),
    log,
    ...(windows ? { terminate: (child: ChildProcess) => { if (child.connected) child.send("relo-shutdown"); else child.kill("SIGTERM"); } } : {}),
  });
  process.on("SIGTERM", () => void stop.shutdown("SIGTERM"));
  process.on("SIGINT", () => void stop.shutdown("SIGINT"));
  // Windows has no SIGTERM: the pipe (and the launcher's stdin) ask for the same graceful stop, and the pipe is the
  // one-supervisor-per-data-root lock, taken before anything else is touched.
  if (windows) {
    await listenForStop({
      pipeName: controlPipeName(layout.root),
      stdin: values["stop-on-stdin-close"] ? process.stdin : null,
      onStop: (reason) => void stop.shutdown(reason),
    });
  }
  const startedAt = performance.now();
  let failed = false;
  let started = false;
  const startChildren = (config: LocalConfig, secrets: Record<SecretName, string>) => {
    if (started) return;
    started = true;
    const env = childEnvironment(layout, config, secrets);
    const halted = () => stop.isStopping() || failed;
    api = supervise("api", "index.js", env, halted);
    worker = supervise("worker", "worker.js", env, halted);
  };
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare(layout, startChildren);
  } catch (error) {
    // Children started early must not outlive a start that failed.
    failed = true;
    for (const child of [api?.child(), worker?.child()]) child?.kill("SIGTERM");
    throw error;
  }
  const { config, secrets, warm } = prepared;
  if (stop.isStopping()) return;
  startChildren(config, secrets);
  const env = childEnvironment(layout, config, secrets);
  await writeFile(path.join(layout.run, "supervisor.json"),
    `${JSON.stringify({ pid: process.pid, port: config.port, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  log("serving", { url: env.APP_URL, instance: config.instance, warm, ms: Math.round(performance.now() - startedAt) });
}

/** For invite: the running install's config and secrets, never a second PostgreSQL. */
async function runningInstall() {
  const config = await readLocalConfig(layout).catch(() => fail("Relo isn't installed here: run the installer first"));
  if (!await postgres.running(layout)) fail("Relo isn't running: start it with relo local start");
  return { config, secrets: await ensureSecrets(layout) };
}

async function printInvite() {
  const { config, secrets } = await runningInstall();
  const input = createInviteSchema.parse({
    ...(values.level ? { level: values.level } : {}),
    ...(values.approvals ? { approvals: true } : {}),
    ...(values.agent?.length ? { agents: values.agent } : {}),
    desktopApp: Boolean(values["mac-app"]),
  });
  const db = createDatabase(socketUrl(layout, databasePort(layout, config), "relo", secrets["postgres-password"], "relo"));
  try {
    const invite = await localInvite(db, config.handle, input, `http://127.0.0.1:${config.port}`);
    console.log(JSON.stringify({ code: invite.code, expiresAt: invite.expiresAt, apiUrl: `http://127.0.0.1:${config.port}`, macApp: invite.desktopApp }));
  } finally { await db.end(); }
}

async function printOwner() {
  await readFile(path.join(layout.secrets, "owner-password"), "utf8").catch(() => fail("no owner yet: run prepare first"));
  const config = await readLocalConfig(layout);
  console.log(JSON.stringify({ email: LOCAL_OWNER_EMAIL, passwordFile: path.join(layout.secrets, "owner-password"),
    dashboard: `http://127.0.0.1:${config.port}/` }));
}

/** Windows: asks the running supervisor to stop (drain the API and worker, stop PostgreSQL) and waits until it has. */
async function stopRunning() {
  if (!windows) fail("stop is for Windows; elsewhere send the supervisor SIGTERM (launchctl kickstart -k)");
  const answered = await requestStop(controlPipeName(layout.root));
  const marker = path.join(layout.run, "supervisor.json");
  const deadline = Date.now() + 90_000;
  // The supervisor removes supervisor.json last, just before it exits.
  while (answered && Date.now() < deadline && await readFile(marker).then(() => true, () => false)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(JSON.stringify({ stopped: true, wasRunning: answered }));
}

async function prepareOnly() {
  // The supervisor's pipe doubles as the lock: a prepare would stop the database under a running server.
  const lock = windows ? await listenForStop({ pipeName: controlPipeName(layout.root), onStop: () => undefined }) : null;
  const { config } = await prepare(layout);
  // The installer's first step: leave PostgreSQL stopped, so the LaunchAgent's run owns it from the start.
  await postgres.stop(layout);
  await lock?.close();
  console.log(JSON.stringify({ prepared: true, port: config.port }));
}

const commands: Record<string, () => Promise<void>> = { run: runServer, prepare: prepareOnly, invite: printInvite, owner: printOwner, stop: stopRunning };
const selected = commands[command];
if (!selected) fail(`unknown command ${command} (run, prepare, invite, owner, stop)`);
await selected().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
