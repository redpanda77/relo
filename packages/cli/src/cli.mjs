import { captureActivityCommand } from "./activity-command-store.mjs";
import { prepareNotificationCommand } from "./notification-command-store.mjs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.mjs";
import { ReloApiClient } from "./api-client.mjs";
import { configPath, configRevision, environmentConfig, loadConfig, removeConfig, writeConfig } from "./config.mjs";
import { EXIT, UsageError, normalizeError } from "./errors.mjs";
import { runDoctor } from "./doctor.mjs";
import { commandSchema } from "./schema.mjs";
import { runActivityCommand } from "./commands/activity.mjs";
import { runAdminCommand } from "./commands/admin.mjs";
import { isReadyResponse, openBrowser, runAuthCommand, safeCredential } from "./commands/auth.mjs";
import { runNotifyCommand } from "./commands/notify.mjs";
import { GUIDE, HELP, IDENTITY_HELP } from "./help.mjs";
import { detectIdentityDefaults } from "./identity.mjs";
import { assertAllowedOptions, assertNoExtra, getAuthenticated, readStdinJson, result } from "./support.mjs";

const VERSION = "0.9.2";

async function executeCommand(parsed, dependencies) {
  const { positionals, options } = parsed;
  if (options.version) {
    if (positionals.length > 0) throw new UsageError("--version cannot be combined with a command");
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
    assertNoExtra(positionals.slice(1), 0, "Usage: relo schema [--json]");
    assertAllowedOptions(options, []);
    return result("schema", commandSchema({ version: VERSION, exitCodes: {
      0: "success, approved, yes, or replied", 1: "server or other failure", 2: "usage error",
      3: "authentication or scope", 4: "timed out, canceled, or expired", 5: "denied or no",
      6: "network", 7: "no phone accepted the push",
    } }));
  }
  let [group, action, ...rest] = positionals;
  if (
    group === "notify"
    && (action === undefined || !["send", "ask", "withdraw"].includes(action) || parsed.separatorAt === 1)
  ) {
    rest = action === undefined ? [] : [action, ...rest];
    action = "send";
  }

  if (group === "doctor") {
    if (action !== undefined) throw new UsageError("Usage: relo doctor [--smoke]");
    assertAllowedOptions(options,["smoke"]);
    return runDoctor(options,dependencies,{ isReadyResponse,safeCredential });
  }

  const command = { parsed, positionals, options, group, action, rest, dependencies };
  const authResult = await runAuthCommand(command);
  if (authResult !== undefined) return authResult;
  const { config, client } = await getAuthenticated(dependencies);
  Object.assign(command, { config, client });
  for (const runGroup of [runNotifyCommand, runActivityCommand, runAdminCommand]) {
    const output = await runGroup(command);
    if (output !== undefined) return output;
  }
  throw new UsageError(`Unknown command: ${positionals.join(" ")}`);
}

function createDependencies(overrides = {}) {
  return {
    env: overrides.env ?? process.env,
    identityDefaults: overrides.identityDefaults
      ?? (() => detectIdentityDefaults(overrides.env ?? process.env, overrides.cwd ?? process.cwd())),
    commandOccurredAt: (overrides.now ?? Date.now)(),
    captureActivityCommand: overrides.captureActivityCommand ?? captureActivityCommand,
    prepareNotificationCommand: overrides.prepareNotificationCommand ?? prepareNotificationCommand,
    activityCaptureDirectory: overrides.activityCaptureDirectory,
    configPath: overrides.configPath ?? (() => configPath({ env: overrides.env ?? process.env })),
    loadConfig: overrides.loadConfig ?? ((path) => environmentConfig(overrides.env ?? process.env) ?? loadConfig(path)),
    writeConfig: overrides.writeConfig ?? writeConfig,
    removeConfig: overrides.removeConfig ?? removeConfig,
    configRevision: overrides.configRevision ?? configRevision,
    clientFactory:
      overrides.clientFactory ??
      ((config) =>
        new ReloApiClient({
          ...config,
          version: VERSION,
          fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
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
    probeOpenCodeRuntime: overrides.probeOpenCodeRuntime,
  };
}

export async function execute(argv, overrides = {}) {
  const dependencies = createDependencies(overrides);
  const parsed = parseArgs(argv);
  return executeCommand(parsed, dependencies);
}

function successEnvelope(output) {
  return { ok: output.exitCode === EXIT.OK, command: output.command, data: output.data };
}

function errorEnvelope(error) {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details?.hint === undefined ? {} : { hint: error.details.hint }),
      ...(() => {
        if (error.details === undefined) return {};
        const { hint: _hint, ...details } = error.details;
        return Object.keys(details).length > 0 ? { details } : {};
      })(),
    },
  };
}

export async function run(argv, io = {}, overrides = {}) {
  const stdout = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const wantsJson = argv.includes("--json");
  // Piped or captured output (agents, scripts) always gets the structured error envelope.
  const stdoutIsTTY = io.stdoutIsTTY ?? (io.stdout ? true : Boolean(process.stdout.isTTY));
  const structuredErrors = wantsJson || !stdoutIsTTY;
  try {
    const output = await execute(argv, {
      ...overrides,
      stderr: overrides.stderr ?? stderr,
      stderrIsTTY: overrides.stderrIsTTY ?? Boolean(process.stderr.isTTY),
    });
    if (output.command === "help" && !wantsJson) stdout(output.data.help);
    else if (output.command === "version" && !wantsJson) stdout(output.data.version);
    else stdout(JSON.stringify(successEnvelope(output)));
    if (output.message) stderr(output.message);
    return output.exitCode;
  } catch (cause) {
    const error = normalizeError(cause);
    if (structuredErrors) stdout(JSON.stringify(errorEnvelope(error)));
    stderr(`${error.code}: ${error.message}`);
    if (error.details?.hint) stderr(`hint: ${error.details.hint}`);
    return error.exitCode;
  }
}

export { agentSession, cardKey, detectIdentityDefaults } from "./identity.mjs";
export { GUIDE, HELP, IDENTITY_HELP } from "./help.mjs";
export { VERSION };
export { EXIT } from "./errors.mjs";
export { parseArgs, parseDuration } from "./args.mjs";
