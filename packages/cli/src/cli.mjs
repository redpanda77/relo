import { captureActivityCommand } from "./activity-command-store.mjs";
import { prepareNotificationCommand } from "./notification-command-store.mjs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.mjs";
import { ReloApiClient } from "./api-client.mjs";
import { configPath, configRevision, environmentConfig, loadAccountsSync, loadComputerNameSync, loadConfig, removeConfig, switchProfile, writeConfig } from "./config.mjs";
import { EXIT, ReloError, UsageError, normalizeError } from "./errors.mjs";
import { runDoctor } from "./doctor.mjs";
import { commandSchema } from "./schema.mjs";
import { runAccountCommand } from "./commands/account.mjs";
import { runActivityCommand } from "./commands/activity.mjs";
import { runAdminCommand } from "./commands/admin.mjs";
import { isReadyResponse, openBrowser, runAuthCommand, safeCredential } from "./commands/auth.mjs";
import { runHookCommand } from "./commands/hook.mjs";
import { runNotifyCommand } from "./commands/notify.mjs";
import { runSessionsCommand } from "./commands/sessions.mjs";
import { runTestCommand } from "./commands/test.mjs";
import { clearPendingLogin, pendingLoginPath, readPendingLogin, writePendingLogin } from "./pending-login.mjs";
import { runSetupCommand } from "./commands/setup.mjs";
import { runSkillCommand } from "./commands/skill.mjs";
import { runKeysCommand } from "./commands/keys.mjs";
import { runUpdateCommand } from "./commands/update.mjs";
import { GUIDE, HELP, IDENTITY_HELP } from "./help.mjs";
import { detectComputerName, detectIdentityDefaults, detectOrigin } from "./identity.mjs";
import { errorLine, errorText, successLine } from "./output.mjs";
import { selectSchemaCommands, unknownCommandHint } from "./suggest.mjs";
import { assertAllowedOptions, assertNoExtra, getAuthenticated, readStdinJson, result } from "./support.mjs";

const VERSION = "0.13.0";

async function executeCommand(parsed, dependencies) {
  const { positionals, options } = parsed;
  if (options.version && positionals[0] !== "update") {
    if (positionals.length > 0) throw new UsageError("--version is not valid for this command (relo --version prints the version on its own)");
    assertAllowedOptions(options, ["version"]);
    return result("version", { version: VERSION });
  }
  if (positionals[0] === "help") {
    const topic = positionals[1];
    if (positionals.length > 2) throw new UsageError("Usage: relo help [identity|all]");
    if (topic === undefined) return result("help", { help: GUIDE });
    if (topic === "identity") return result("help", { help: IDENTITY_HELP });
    if (topic === "all") return result("help", { help: HELP });
    throw new UsageError(`Unknown help topic: ${topic}`, { hint: "Run relo help, relo help identity, or relo help all" });
  }
  if (options.help || positionals.length === 0) return result("help", { help: GUIDE });
  if (positionals[0] === "schema") {
    assertAllowedOptions(options, []);
    let only;
    if (positionals.length > 1) {
      const selected = selectSchemaCommands(positionals.slice(1));
      if (selected.error) throw new UsageError(selected.error, { hint: selected.hint });
      only = selected.commands;
    }
    return result("schema", commandSchema({ version: VERSION, only, exitCodes: {
      0: "success, approved, yes, or replied", 1: "server or other failure", 2: "usage error",
      3: "authentication or scope", 4: "timed out, canceled, or expired", 5: "denied or no",
      6: "network", 7: "no phone accepted the push",
    } }));
  }
  if (positionals[0] === "mcp") {
    assertAllowedOptions(options, []);
    throw new UsageError("Usage: relo mcp", { hint: "A stdio MCP server for a harness to launch, taking no arguments. Add it with: relo setup --mcp --agent <name> --global" });
  }
  let [group, action, ...rest] = positionals;
  if (
    group === "notify"
    && (action === undefined || !["send", "ask", "withdraw"].includes(action) || parsed.separatorAt === 1)
  ) {
    rest = action === undefined ? [] : [action, ...rest];
    action = "send";
  }

  const unknownHint = unknownCommandHint(group, action);
  if (unknownHint !== undefined) throw new UsageError(`Unknown command: ${positionals.join(" ")}`, { hint: unknownHint });

  if (group === "doctor") {
    if (action !== undefined) throw new UsageError("Usage: relo doctor [--smoke] [--full]");
    assertAllowedOptions(options,["smoke"]);
    return runDoctor(options,dependencies,{ isReadyResponse,safeCredential });
  }

  if (options.profile !== undefined && !(group === "auth" && action === "login")) {
    throw new UsageError("--profile is not valid for this command", { hint: "Set RELO_PROFILE=NAME, or relo auth switch NAME" });
  }
  if (group === "auth" && action === "login" && options.profile !== undefined) dependencies.profile = options.profile;
  const command = { parsed, positionals, options, group, action, rest, dependencies };
  const hookResult = await runHookCommand(command);
  if (hookResult !== undefined) return hookResult;
  const setupResult = await runSetupCommand(command);
  if (setupResult !== undefined) return setupResult;
  const skillResult = await runSkillCommand(command);
  if (skillResult !== undefined) return skillResult;
  const updateResult = await runUpdateCommand(command);
  if (updateResult !== undefined) return updateResult;
  const accountResult = await runAccountCommand(command);
  if (accountResult !== undefined) return accountResult;
  const authResult = await runAuthCommand(command);
  if (authResult !== undefined) return authResult;
  // --dry-run validates locally and never needs a login or a request: its client refuses every call.
  const dryRun = Boolean(options["dry-run"]) && (group === "ask" || group === "notify" && action === "send"
    || group === "activity" && ["start", "update", "end"].includes(action));
  if (dryRun) dependencies.dryRun = true;
  const { config, client } = dryRun ? { config: undefined, client: refusingClient() } : await getAuthenticated(dependencies);
  Object.assign(command, { config, client });
  for (const runGroup of [runNotifyCommand, runActivityCommand, runAdminCommand, runTestCommand, runSessionsCommand, runKeysCommand]) {
    const output = await runGroup(command);
    if (output !== undefined) return output;
  }
  throw new UsageError(`Unknown command: ${positionals.join(" ")}`, { hint: "Commands: relo help all" });
}

function refusingClient() {
  return new Proxy({}, { get: (_, method) => () => {
    throw new ReloError(`--dry-run made a request (${String(method)}); this is a bug`, { code: "DRY_RUN_REQUEST" });
  } });
}

function createDependencies(overrides = {}) {
  const env = overrides.env ?? process.env;
  const configPathOf = overrides.configPath ?? (() => configPath({ env }));
  const loadAccounts = overrides.loadAccounts ?? (() => loadAccountsSync(configPathOf()));
  const probes = {
    platform: overrides.platform, scutil: overrides.scutil, hostname: overrides.hostname, home: overrides.home,
    accounts: loadAccounts,
  };
  const identityDefaults = overrides.identityDefaults
    ?? (() => detectIdentityDefaults(env, overrides.cwd ?? process.cwd()));
  // Stubbing the identity stubs out the machine too, so tests never depend on the computer they run on.
  const originDefaults = overrides.originDefaults
    ?? (overrides.identityDefaults ? () => ({}) : () => detectOrigin(env, probes));
  let origin;
  const dependencies = {
    env,
    // The profile this command runs as: `auth login --profile` (set in execute), else RELO_PROFILE, else the active one.
    profile: env.RELO_PROFILE?.trim() || undefined,
    home: overrides.home ?? homedir(),
    cwd: overrides.cwd ?? process.cwd(),
    version: overrides.version ?? VERSION,
    identityDefaults,
    creationDefaults: () => ({ ...identityDefaults(), ...(origin ??= originDefaults()) }),
    computerName: overrides.computerName ?? (() => detectComputerName(env, probes)),
    accountProbes: probes,
    loadAccounts,
    commandOccurredAt: (overrides.now ?? Date.now)(),
    captureActivityCommand: overrides.captureActivityCommand ?? captureActivityCommand,
    prepareNotificationCommand: overrides.prepareNotificationCommand ?? prepareNotificationCommand,
    activityCaptureDirectory: overrides.activityCaptureDirectory,
    configPath: configPathOf,
    loadConfig: overrides.loadConfig ?? ((path) => environmentConfig(env) ?? loadConfig(path, { profile: dependencies.profile })),
    loadStoredConfig: overrides.loadStoredConfig ?? ((path) => loadConfig(path, { profile: dependencies.profile })),
    loadComputerName: overrides.loadComputerName ?? (() => loadComputerNameSync(configPathOf())),
    writeConfig: overrides.writeConfig ?? writeConfig,
    switchProfile: overrides.switchProfile ?? switchProfile,
    removeConfig: overrides.removeConfig ?? ((path, options) => removeConfig(path, { profile: dependencies.profile, ...options })),
    stdinIsTTY: overrides.stdinIsTTY ?? Boolean(process.stdin.isTTY),
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
    hookStateDirectory: overrides.hookStateDirectory
      ?? join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "relo", "hooks"),
    configRevision: overrides.configRevision ?? configRevision,
    pendingLogin: overrides.pendingLogin ?? {
      read: () => readPendingLogin(pendingLoginPath(configPathOf())),
      write: (value) => writePendingLogin(pendingLoginPath(configPathOf()), value),
      clear: () => clearPendingLogin(pendingLoginPath(configPathOf())),
    },
    clientFactory:
      overrides.clientFactory ??
      ((config) =>
        new ReloApiClient({
          ...config,
          version: VERSION,
          fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
          sleep: dependencies.sleep,
        })),
    now: overrides.now ?? (() => Date.now()),
    sleep:
      overrides.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    generateIdempotencyKey: overrides.generateIdempotencyKey ?? randomUUID,
    readStdinJson: overrides.readStdinJson ?? (() => readStdinJson(overrides.stdinStream ?? process.stdin)),
    readTextFile: overrides.readTextFile ?? (async (path) => {
      const contents = await readFile(path, "utf8").catch((error) => {
        throw new UsageError(`Cannot read ${path}: ${error.code ?? "unreadable"}`);
      });
      if (contents.length > 4_096) throw new UsageError(`${path} is larger than 4 KiB`);
      return contents;
    }),
    permissionsHome: overrides.permissionsHome ?? homedir(),
    nodePath: overrides.nodePath ?? process.execPath,
    entrypoint:
      overrides.entrypoint ?? fileURLToPath(new URL("../bin/relo.mjs", import.meta.url)),
    openBrowser: overrides.openBrowser ?? openBrowser,
    stderr: overrides.stderr ?? (() => {}),
    stderrIsTTY: overrides.stderrIsTTY ?? false,
    platform: overrides.platform ?? process.platform,
    uid: overrides.uid ?? process.getuid?.(),
    runPermissionCommand: overrides.runPermissionCommand,
    beforePermissionCommit: overrides.beforePermissionCommit,
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    runNpm: overrides.runNpm,
    // Doctor's update check goes to the network only in a real process; a test that injects its own client or fetch opts in with `releaseFetch`.
    releaseFetch: overrides.releaseFetch ?? (overrides.clientFactory || overrides.fetchImpl ? undefined : globalThis.fetch),
    probeOpenCodeRuntime: overrides.probeOpenCodeRuntime,
  };
  return dependencies;
}

export async function execute(argv, overrides = {}) {
  const dependencies = createDependencies(overrides);
  const parsed = parseArgs(argv);
  return executeCommand(parsed, dependencies);
}

// Flags only count before a `--` separator; after it everything is the caller's text.
function hasFlag(argv, flag) {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes(flag);
}

export async function run(argv, io = {}, overrides = {}) {
  // Hooks are the one command that never speaks: no stdout (Claude Code injects it into the model's
  // context), no failures, always exit 0. See commands/hook.mjs.
  if (argv[0] === "hook") {
    try {
      const dependencies = createDependencies(overrides);
      const parsed = parseArgs(argv);
      await runHookCommand({ parsed, positionals: parsed.positionals, options: parsed.options, group: "hook",
        action: parsed.positionals[1], rest: parsed.positionals.slice(2), dependencies });
    } catch { /* a hook never fails the agent */ }
    return 0;
  }
  // `relo mcp`: a stdio MCP server. stdout carries protocol messages only, so anything else that
  // tries to print there goes to stderr instead.
  if (argv.length === 1 && argv[0] === "mcp") {
    const { serveMcp } = await import("./mcp.mjs");
    const input = io.stdin ?? process.stdin;
    const output = io.mcpOutput ?? (() => {
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (...parts) => process.stderr.write(...parts);
      console.log = console.info = console.debug = (...parts) => process.stderr.write(`${parts.join(" ")}\n`);
      return { write };
    })();
    await serveMcp({ input, output, run, version: overrides.version ?? VERSION, env: overrides.env ?? process.env, overrides, progressIntervalMs: io.progressIntervalMs });
    return 0;
  }
  const stdout = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const wantsJson = hasFlag(argv, "--json");
  const full = hasFlag(argv, "--full");
  // Piped or captured output (agents, scripts) gets exactly one JSON line per outcome and nothing
  // on stderr; a person at a terminal gets plain text on stderr.
  const stdoutIsTTY = io.stdoutIsTTY ?? (io.stdout ? true : Boolean(process.stdout.isTTY));
  const structured = wantsJson || !stdoutIsTTY;
  try {
    const output = await execute(argv, {
      ...overrides,
      stderr: overrides.stderr ?? stderr,
      stderrIsTTY: overrides.stderrIsTTY ?? Boolean(process.stderr.isTTY),
    });
    if (output.command === "help" && !wantsJson) stdout(output.data.help);
    else if (output.command === "version" && !wantsJson) stdout(output.data.version);
    else {
      // A compact line carries its notices itself when nobody is reading stderr.
      const notice = [output.message, ...(output.notes ?? [])].filter(Boolean).join("; ");
      // Doctor's compact line already says what is wrong in `next.why`; don't repeat it.
      const repeated = !full && structured && output.command === "doctor";
      const inline = !full && structured && notice && !repeated;
      stdout(JSON.stringify(successLine(output, { full, note: inline ? notice : undefined })));
      if (notice && !inline && !repeated) stderr(notice);
    }
    return output.exitCode;
  } catch (cause) {
    const error = normalizeError(cause);
    const line = errorLine(error, { full, group: argv.find((word) => !word.startsWith("--")) });
    if (structured) stdout(JSON.stringify(line));
    else stderr(errorText(line));
    return error.exitCode;
  }
}

export { agentSession, cardKey, detectIdentityDefaults } from "./identity.mjs";
export { GUIDE, HELP, IDENTITY_HELP } from "./help.mjs";
export { VERSION };
export { EXIT } from "./errors.mjs";
export { parseArgs, parseDuration } from "./args.mjs";
