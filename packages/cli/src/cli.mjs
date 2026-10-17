import { parseArgs } from "./args.mjs";
import { exitCodeMeanings, ReloError, UsageError } from "./shared/errors.mjs";
import { commandSchema } from "./schema.mjs";
import { runHook } from "./harness/entry.mjs";
import { createDependencies } from "./deps.mjs";
import { VERSION } from "./version.mjs";
import { GUIDE, HELP, IDENTITY_HELP, commandHelp, groupHelp } from "./help.mjs";
import { detectAgent, ownerCaller, surfaceFor } from "./caller.mjs";
import { fstatSync, statSync } from "node:fs";
import { ADMIN_USAGE } from "./owner/spec.mjs";
import { COMMANDS, findAdminCommand, findCommand, handlerFor, optionsOf } from "./registry.mjs";
import { refuseOwnerOnly } from "./agent/guards.mjs";
import { outputMode, printFailure, printOutcome } from "./shared/output.mjs";
import { missingAction, selectSchemaCommands, unknownCommandHint } from "./suggest.mjs";
import { assertAllowedOptions } from "./shared/validate.mjs";
import { getAuthenticated } from "./shared/login.mjs";
import { result } from "./shared/outcome.mjs";
import { integrationProject } from "./shared/identity.mjs";
export { integrationProject };
import { withSessionNotes } from "./agent/session-notes.mjs";
import { latestCliSeen } from "./shared/api-client.mjs";


async function executeCommand(parsed, dependencies) {
  const { positionals, options } = parsed;
  if (options.version && positionals[0] !== "update") {
    if (positionals.length > 0) throw new UsageError("--version is not valid for this command (relo --version prints the version on its own)");
    assertAllowedOptions(options, ["version"]);
    return result("version", { version: VERSION });
  }
  if (positionals[0] === "help") {
    const [, topic, ...words] = positionals;
    if (topic === undefined) return result("help", { help: GUIDE });
    if (topic === "identity" && words.length === 0) return result("help", { help: IDENTITY_HELP });
    if (topic === "all" && words.length === 0) return result("help", { help: HELP });
    const help = helpFor(topic, words[0], dependencies);
    if (help) return result("help", { help });
    throw new UsageError(`No help for "${[topic, ...words].join(" ")}"`, { hint: unknownCommandHint(topic, words[0]) ?? "relo help (the guide), relo help all (every command), relo help identity" });
  }
  if (positionals.length === 0) return result("help", { help: GUIDE });
  if (options.help) return result("help", { help: helpFor(positionals[0], positionals[1], dependencies) ?? GUIDE });
  if (positionals[0] === "schema") {
    assertAllowedOptions(options, []);
    let only;
    if (positionals.length > 1) {
      const selected = selectSchemaCommands(positionals.slice(1));
      if (selected.error) throw new UsageError(selected.error, { hint: selected.hint });
      only = selected.commands;
    }
    return result("schema", commandSchema({ version: VERSION, only, exitCodes: exitCodeMeanings() }));
  }
  if (positionals[0] === "mcp") {
    assertAllowedOptions(options, []);
    throw new UsageError("Usage: relo mcp", { hint: "A stdio MCP server for a harness to launch, taking no arguments. Add it with: relo setup --mcp --agent <name> --global" });
  }
  let [group, action, ...rest] = positionals;
  let entry;
  // `relo admin …` is the owner's cross-session surface (from the owner's terminal, or an agent the owner
  // asked for help): it always runs as the owner, never as the calling session.
  if (group === "admin") {
    const admin = action === undefined ? undefined : findAdminCommand(action, rest[0]);
    if (!admin) {
      throw new UsageError(action === undefined ? ADMIN_USAGE : `relo admin has no "${positionals.slice(1).join(" ")}"`, action === undefined ? {} : { hint: ADMIN_USAGE });
    }
    dependencies.caller = ownerCaller(dependencies.caller);
    entry = admin.entry;
    if (!entry.name.startsWith("admin ")) [group, action, ...rest] = positionals.slice(1);
  }
  if (
    group === "notify"
    && (action === undefined || !["send", "ask", "withdraw"].includes(action) || parsed.separatorAt === 1)
  ) {
    rest = action === undefined ? [] : [action, ...rest];
    action = "send";
  }

  entry ??= findCommand(group, action);
  const handler = entry && !entry.root ? handlerFor(entry, surfaceFor(dependencies.caller)) : undefined;
  if (!handler?.load) {
    const message = missingAction(group, action) ? `relo ${group} needs a command` : `Unknown command: ${positionals.join(" ")}`;
    throw new UsageError(message, { hint: unknownCommandHint(group, action) ?? "Commands: relo help all" });
  }

  if (options.profile !== undefined && !(group === "auth" && action === "login")) {
    throw new UsageError("--profile is not valid for this command", { hint: "Set RELO_PROFILE=NAME, or relo auth switch NAME" });
  }
  if (group === "auth" && action === "login" && options.profile !== undefined) dependencies.profile = options.profile;
  // The entry's options are the command's: anything else is refused here, once, unless the type's own
  // module refuses it in its own form (an agent's work commands).
  const allowed = handler.options ?? entry.options;
  if (!handler.ownsRefusals) assertAllowedOptions(options, allowed);
  const command = { parsed, positionals, options, group, action, rest, dependencies, allowed };
  // Plan 2.8 (STATE-SPEC 4.1): commands that show every session are the owner's, refused inside a harness.
  if (entry.ownerOnly && surfaceFor(dependencies.caller) === "agent") throw refuseOwnerOnly(entry.name, dependencies.caller);
  if (handler.auth === "client") {
    // --dry-run validates locally and never needs a login or a request: its client refuses every call.
    const dryRun = Boolean(options["dry-run"]) && Boolean(handler.dryRunnable);
    if (dryRun) dependencies.dryRun = true;
    const { config, client } = dryRun ? { config: undefined, client: refusingClient() } : await getAuthenticated(dependencies);
    Object.assign(command, { config, client });
    // Outside a repository an app's work belongs to the integration it signed in as.
    const detected = dependencies.creationDefaults;
    dependencies.creationDefaults = () => {
      const defaults = detected();
      const project = defaults.project ?? integrationProject(config, dependencies);
      return project === undefined ? defaults : { ...defaults, project };
    };
  }
  // A command that sends messages gets its caller type's message port (agent/ or script/messages.mjs).
  if (handler.port) dependencies.messages = (await handler.port()).default;
  const output = await (await handler.load())[handler.run](command);
  if (output === undefined) throw new UsageError(`Unknown command: ${positionals.join(" ")}`, { hint: "Commands: relo help all" });
  return output;
}

/** Help for `relo help GROUP [ACTION]` and `relo GROUP ACTION --help`: that command's, for this caller. */
function helpFor(group, action, dependencies) {
  if (action === undefined) {
    // A group (relo help keys, relo help admin): its commands; admin also runs every cross-session view.
    const members = group === "admin"
      ? [...COMMANDS.filter((entry) => entry.name.startsWith("admin ")), ...COMMANDS.filter((entry) => entry.admin)]
      : COMMANDS.filter((entry) => entry.name.startsWith(`${group} `) && !entry.internal);
    if (members.length && !COMMANDS.some((entry) => entry.name === group)) {
      return groupHelp(group, group === "admin" ? members.map((entry) => (entry.name.startsWith("admin ") ? entry : { ...entry, name: `admin ${entry.name}`, alias: undefined })) : members);
    }
  }
  const entry = group === "admin" ? findAdminCommand(action, undefined)?.entry : findCommand(group, action);
  if (!entry?.name || entry.root && entry.name !== group) return undefined;
  const surface = group === "admin" ? "owner" : surfaceFor(dependencies.caller);
  return commandHelp(entry, handlerFor(entry, surface)?.options ?? optionsOf(entry));
}

function refusingClient() {
  return new Proxy({}, { get: (_, method) => () => {
    throw new ReloError(`--dry-run made a request (${String(method)}); this is a bug`, { code: "DRY_RUN_REQUEST" });
  } });
}

export async function execute(argv, overrides = {}) {
  const dependencies = createDependencies(overrides);
  dependencies.argv = argv;
  const parsed = parseArgs(argv);
  const output = await executeCommand(parsed, dependencies);
  // The server offers a newer CLI (seen on a reply): an install-script CLI updates itself in the background.
  const latest = latestCliSeen();
  if (latest && latest !== dependencies.version && argv[0] !== "update") {
    const { maybeStartAutoUpdate } = await import("./owner/auto-update.mjs");
    const { compareVersions } = await import("./owner/releases.mjs");
    dependencies.autoUpdating = maybeStartAutoUpdate({ latest, version: dependencies.version, home: dependencies.home, entrypoint: dependencies.entrypoint,
      env: dependencies.env, now: dependencies.now?.() ?? Date.now(), compare: compareVersions, spawnImpl: dependencies.spawnAutoUpdate });
  }
  return withSessionNotes(output, dependencies);
}

/** How long `relo mcp` waits after its client closes stdin before it asks whether the harness is gone, and how often it runs the liveness sweep. */
const MCP_LEAVE_GRACE_MS = 1_500;
const MCP_TICK_MS = 60_000;

/** True when stdout is /dev/null (the same device and inode); false when unknown. */
function stdoutIsDevNull() {
  try {
    const out = fstatSync(1);
    const sink = statSync("/dev/null");
    return out.isCharacterDevice() && out.rdev === sink.rdev && out.ino === sink.ino;
  } catch {
    return false;
  }
}

export async function run(argv, io = {}, overrides = {}) {
  // Hooks are the one command that never speaks: no stdout (Claude Code injects it into the model's
  // context), no failures, always exit 0. See harness/entry.mjs.
  if (argv[0] === "hook") return runHook(argv, overrides);
  // The status line wrapper is as silent about failures: it prints the owner's own status line and exits 0.
  if (argv.length === 1 && argv[0] === "statusline") return (await import("./harness/entry.mjs")).runStatusline(overrides);
  // `relo mcp`: a stdio MCP server. stdout carries protocol messages only, so anything else that
  // tries to print there goes to stderr instead.
  if (argv.length === 1 && argv[0] === "mcp") {
    const { serveMcp } = await import("./agent/mcp.mjs");
    const input = io.stdin ?? process.stdin;
    const output = io.mcpOutput ?? (() => {
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (...parts) => process.stderr.write(...parts);
      console.log = console.info = console.debug = (...parts) => process.stderr.write(`${parts.join(" ")}\n`);
      return { write };
    })();
    // The harness is this process's parent (Claude Code starts `relo mcp` itself). Captured now: once it is gone ppid is 1.
    const harnessPid = overrides.parentPid ?? process.ppid;
    const { endProcessSessions, heartbeatSessions, listSessionRecords, sweepSessions } = await import("./harness/entry.mjs");
    // Once a minute while the server runs, the throttled liveness sweep, so a quit session is found even when no hook fires
    // anywhere, and one heartbeat for each session of this harness at a permission prompt (hooks send nothing while it waits).
    const tick = setInterval(() => {
      (async () => {
        const records = await listSessionRecords(overrides);
        await sweepSessions(overrides, records);
        await heartbeatSessions({ pid: harnessPid }, overrides, records);
      })().catch(() => {});
    }, io.mcpTickMs ?? MCP_TICK_MS);
    tick.unref();
    // A closed terminal sends SIGHUP, which would end node before the leave below could run. Ignored here: the harness's own
    // exit closes stdin (EOF), and that drives the leave. SIGTERM is left alone, so a stuck server can still be stopped.
    const ignoreHangup = () => {};
    process.on("SIGHUP", ignoreHangup);
    try {
      await serveMcp({ input, output, run, version: overrides.version ?? VERSION, env: overrides.env ?? process.env, overrides, progressIntervalMs: io.progressIntervalMs,
        // The client closed stdin. A /mcp reconnect does that while the harness lives, so only a parent that is still gone
        // after a short wait ends its sessions.
        onClose: async () => {
          await new Promise((resolve) => setTimeout(resolve, io.mcpLeaveGraceMs ?? MCP_LEAVE_GRACE_MS));
          const { processAlive } = await import("./harness/core/liveness-probe.mjs");
          const alive = overrides.harnessProcess?.processAlive ?? processAlive;
          if (Number.isInteger(harnessPid) && harnessPid > 1 && !await alive({ pid: harnessPid })) await endProcessSessions({ pid: harnessPid }, overrides);
        } });
    } finally {
      clearInterval(tick);
      process.removeListener("SIGHUP", ignoreHangup);
    }
    return 0;
  }
  // An agent that sends a reply to /dev/null never learns what reached the owner: its reply goes to stderr instead.
  const silenced = !io.stdout && detectAgent(overrides.env ?? process.env) && stdoutIsDevNull();
  const stdout = io.stdout ?? ((line) => (silenced ? process.stderr : process.stdout).write(`${line}\n`));
  if (silenced) process.stderr.write("Relo: this reply was sent to /dev/null, so it is shown here. Run relo commands alone and read the reply: Owner sees: is what reached the owner, Next: is what to run.\n");
  const stderr = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const stdoutIsTTY = io.stdoutIsTTY ?? (io.stdout ? true : Boolean(process.stdout.isTTY));
  const mode = outputMode(argv, stdoutIsTTY);
  try {
    const output = await execute(argv, {
      emit: (line) => stdout(JSON.stringify(line)),
      ...overrides,
      stderr: overrides.stderr ?? stderr,
      stderrIsTTY: overrides.stderrIsTTY ?? Boolean(process.stderr.isTTY),
      stdoutIsTTY: overrides.stdoutIsTTY ?? stdoutIsTTY,
    });
    return printOutcome(output, mode, { stdout, stderr });
  } catch (cause) {
    return printFailure(cause, mode, { stdout, stderr }, argv.find((word) => !word.startsWith("--")));
  }
}

