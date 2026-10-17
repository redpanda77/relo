// What a hook uses: the state folders, config, stdin, clock and the detached flusher. A hook runs on every
// tool call, so this module loads no caller, identity or command machinery; deps.mjs extends the same
// object for commands, so both see one set of paths. The one place the state paths are derived.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReloApiClient } from "./shared/api-client.mjs";
import { detectComputerName } from "./shared/computer.mjs";
import { configPath, environmentConfig, loadAccountsSync, loadComputerNameSync, loadConfig, writeConfig } from "./shared/config.mjs";
import { envSetting } from "./shared/settings.mjs";
import { readStdinJson } from "./shared/stdin.mjs";
import { VERSION } from "./version.mjs";
import { stateRoot } from "./work/state-file.mjs";

export const entrypointOf = (overrides) => overrides.entrypoint ?? fileURLToPath(new URL("../bin/relo.mjs", import.meta.url));

export function hookDependencies(overrides = {}) {
  const env = overrides.env ?? process.env;
  const configPathOf = overrides.configPath ?? (() => configPath({ env }));
  const loadAccounts = overrides.loadAccounts ?? (() => loadAccountsSync(configPathOf()));
  const probes = {
    platform: overrides.platform, scutil: overrides.scutil, hostname: overrides.hostname, home: overrides.home,
    accounts: loadAccounts,
  };
  // One home for every default path: the injected one when given (a test or embedder that passes `home`
  // never reaches the process's real ~/.local/state), else HOME. The state folder (stateRoot: RELO_STATE_DIR,
  // XDG_STATE_HOME, then the process's RELO_STATE_DIR) holds hook bookkeeping, observed session state, the
  // outbox and the per-session work files; a test that moves the hook folder moves the rest with it.
  const home = overrides.home ?? homedir();
  const stateDirectory = overrides.stateDirectory
    ?? (overrides.hookStateDirectory ? dirname(overrides.hookStateDirectory) : stateRoot(env, home));
  const dependencies = {
    env,
    // The profile this command runs as: `auth login --profile` (set in execute), else RELO_PROFILE, else the active one.
    profile: envSetting("profile", env),
    home,
    cwd: overrides.cwd ?? process.cwd(),
    version: overrides.version ?? VERSION,
    computerName: overrides.computerName ?? (() => detectComputerName(env, probes)),
    accountProbes: probes,
    loadAccounts,
    // Streaming commands (relo listen) print one JSON line per item as it arrives.
    emit: overrides.emit ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`)),
    configPath: configPathOf,
    loadConfig: overrides.loadConfig ?? ((path) => environmentConfig(env) ?? loadConfig(path, { profile: dependencies.profile })),
    loadStoredConfig: overrides.loadStoredConfig ?? ((path) => loadConfig(path, { profile: dependencies.profile })),
    loadComputerName: overrides.loadComputerName ?? (() => loadComputerNameSync(configPathOf())),
    writeConfig: overrides.writeConfig ?? writeConfig,
    stdinIsTTY: overrides.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    readStdinJson: overrides.readStdinJson ?? (() => readStdinJson(overrides.stdinStream ?? process.stdin)),
    hookStateDirectory: overrides.hookStateDirectory ?? join(stateDirectory, "hooks"),
    // The observed session state files (EDGE.1) and the durable outbox (EDGE.3).
    observedStateDirectory: overrides.observedStateDirectory ?? join(stateDirectory, "observed"),
    outboxDirectory: overrides.outboxDirectory ?? join(stateDirectory, "outbox"),
    // The per-session declared work files (work/session-store.mjs).
    sessionsDirectory: overrides.sessionsDirectory ?? join(stateDirectory, "sessions"),
    // The pending handoff of each project on this computer (work/handoff-store.mjs).
    handoffsDirectory: overrides.handoffsDirectory ?? join(stateDirectory, "handoffs"),
    // Hooks start the outbox flusher detached and return at once (EDGE.6). Only a real process does:
    // a test (which injects its own env) never spawns one. child_process loads only when one is spawned.
    spawnFlusher: overrides.spawnFlusher ?? (overrides.env === undefined && process.env.RELO_NO_BACKGROUND_FLUSH !== "1"
      ? async () => {
        const { spawn } = await import("node:child_process");
        const child = spawn(overrides.nodePath ?? process.execPath, [entrypointOf(overrides), "outbox", "flush"],
          { detached: true, stdio: "ignore", env: process.env, windowsHide: true });
        child.on("error", () => {});
        child.unref();
      }
      : () => {}),
    clientFactory: overrides.clientFactory ?? ((config) => new ReloApiClient({
      ...config, version: VERSION, fetchImpl: overrides.fetchImpl ?? globalThis.fetch, sleep: dependencies.sleep,
    })),
    // The approvals hook runs the session's own `relo ask` and `relo interaction wait` as child processes
    // (harness/core/approve.mjs), so no client or card writer is reachable from hook logic.
    runRelo: overrides.runRelo ?? (async (args, { env: childEnv, cwd } = {}) => {
      const { spawn } = await import("node:child_process");
      return new Promise((resolve) => {
        const child = spawn(overrides.nodePath ?? process.execPath, [entrypointOf(overrides), ...args],
          { env: childEnv ?? process.env, cwd: cwd ?? undefined, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.on("error", () => resolve({ code: 1, stdout: "" }));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
      });
    }),
    // Claude Code ends a hook when the owner answers its own dialog first: withdraw the question then.
    onTerminate: overrides.onTerminate ?? ((handler) => {
      const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
      for (const signal of signals) process.once(signal, handler);
      return () => { for (const signal of signals) process.removeListener(signal, handler); };
    }),
    // The liveness check (harness/core/liveness-probe.mjs): the hook's parent pid and the process probe; tests inject both.
    parentPid: overrides.parentPid,
    harnessProcess: overrides.harnessProcess,
    exit: overrides.exit ?? ((code) => process.exit(code)),
    now: overrides.now ?? (() => Date.now()),
    sleep: overrides.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
  return dependencies;
}
