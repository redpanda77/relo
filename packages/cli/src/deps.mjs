// The dependencies commands run with: the one injection point tests and embedders override. The hook set
// (hook-deps.mjs: state paths, config, stdin, clock) plus the caller, identity defaults and command tools.
// Modules only some commands use load when first called.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { detectCaller } from "./caller.mjs";
import { entrypointOf, hookDependencies } from "./hook-deps.mjs";
import { configRevision, removeConfig, switchProfile } from "./shared/config.mjs";
import { UsageError } from "./shared/errors.mjs";
import { detectIdentityDefaults, detectOrigin } from "./shared/identity.mjs";

export function createDependencies(overrides = {}) {
  const dependencies = hookDependencies(overrides);
  const { env, configPath: configPathOf, accountProbes: probes } = dependencies;
  const identityDefaults = overrides.identityDefaults ?? (() => detectIdentityDefaults(env, dependencies.cwd, undefined, dependencies.loadProjects()));
  // Stubbing the identity stubs out the machine too, so tests never depend on the computer they run on.
  const originDefaults = overrides.originDefaults
    ?? (overrides.identityDefaults ? () => ({}) : () => detectOrigin(env, probes, () => dependencies.loadComputerName?.()));
  let origin;
  const pendingLoginStore = () => import("./owner/pending-login.mjs");
  return Object.assign(dependencies, {
    // Who is calling (agent_session | script | unidentified), resolved once; commands branch on caller.type.
    caller: overrides.caller ?? detectCaller(env),
    identityDefaults,
    creationDefaults: () => ({ ...identityDefaults(), ...(origin ??= originDefaults()) }),
    commandOccurredAt: (overrides.now ?? Date.now)(),
    captureActivityCommand: overrides.captureActivityCommand
      ?? (async (...args) => (await import("./messages/activity-journal.mjs")).captureActivityCommand(...args)),
    prepareNotificationCommand: overrides.prepareNotificationCommand
      ?? (async (...args) => (await import("./messages/notification-journal.mjs")).prepareNotificationCommand(...args)),
    activityCaptureDirectory: overrides.activityCaptureDirectory,
    switchProfile: overrides.switchProfile ?? switchProfile,
    removeConfig: overrides.removeConfig ?? ((path, options) => removeConfig(path, { profile: dependencies.profile, ...options })),
    // Asks the person at the terminal; only commands a person must confirm (relo keys verify) use it.
    confirm: overrides.confirm ?? (async (question) => {
      const { createInterface } = await import("node:readline/promises");
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await prompt.question(question)).trim());
      } finally {
        prompt.close();
      }
    }),
    // Asks for one line of text at the terminal (relo setup's name and icon); `fallback` is what an empty answer means.
    ask: overrides.ask ?? (async (question, fallback) => {
      const { createInterface } = await import("node:readline/promises");
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return (await prompt.question(question)).trim() || fallback;
      } finally {
        prompt.close();
      }
    }),
    stdoutIsTTY: overrides.stdoutIsTTY ?? false,
    configRevision: overrides.configRevision ?? configRevision,
    pendingLogin: overrides.pendingLogin ?? {
      read: async () => { const { pendingLoginPath, readPendingLogin } = await pendingLoginStore(); return readPendingLogin(pendingLoginPath(configPathOf())); },
      write: async (value) => { const { pendingLoginPath, writePendingLogin } = await pendingLoginStore(); return writePendingLogin(pendingLoginPath(configPathOf()), value); },
      clear: async () => { const { clearPendingLogin, pendingLoginPath } = await pendingLoginStore(); return clearPendingLogin(pendingLoginPath(configPathOf())); },
    },
    generateIdempotencyKey: overrides.generateIdempotencyKey ?? randomUUID,
    readTextFile: overrides.readTextFile ?? (async (path) => {
      const contents = await readFile(path, "utf8").catch((error) => {
        throw new UsageError(`Cannot read ${path}: ${error.code ?? "unreadable"}`);
      });
      if (contents.length > 4_096) throw new UsageError(`${path} is larger than 4 KiB`);
      return contents;
    }),
    permissionsHome: overrides.permissionsHome ?? homedir(),
    nodePath: overrides.nodePath ?? process.execPath,
    entrypoint: entrypointOf(overrides),
    openBrowser: overrides.openBrowser ?? (async (...args) => (await import("./owner/auth.mjs")).openBrowser(...args)),
    openMacApp: overrides.openMacApp ?? (async (...args) => (await import("./owner/auth.mjs")).openMacApp(...args)),
    stderr: overrides.stderr ?? (() => {}),
    stderrIsTTY: overrides.stderrIsTTY ?? false,
    platform: overrides.platform ?? process.platform,
    uid: overrides.uid ?? process.getuid?.(),
    runPermissionCommand: overrides.runPermissionCommand,
    beforePermissionCommit: overrides.beforePermissionCommit,
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    runNpm: overrides.runNpm,
    // relo update runs the new CLI's `relo setup --refresh` (owner/releases.mjs); a test injects it.
    runRefresh: overrides.runRefresh,
    // Doctor's update check goes to the network only in a real process; a test that injects its own client or fetch opts in with `releaseFetch`.
    releaseFetch: overrides.releaseFetch ?? (overrides.clientFactory || overrides.fetchImpl ? undefined : globalThis.fetch),
    probeOpenCodeRuntime: overrides.probeOpenCodeRuntime,
    // Tells the server about this computer's setup after a command changed it (owner/machine-report.mjs). Real
    // only in a real process: a test (its own env, or RELO_NO_BACKGROUND_FLUSH) never reaches a server through it.
    sendMachineReport: overrides.sendMachineReport ?? (overrides.env === undefined && process.env.RELO_NO_BACKGROUND_FLUSH !== "1"
      ? async (options) => (await import("./owner/machine-report.mjs")).sendReportIfChanged(dependencies, options)
      : async () => ({ sent: false, reason: "disabled" })),
    recordDoctor: overrides.recordDoctor ?? (async (checks) => (await import("./owner/machine-report.mjs")).recordDoctor(dependencies, checks)),
  });
}
