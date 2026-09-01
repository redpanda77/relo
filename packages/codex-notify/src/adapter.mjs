import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveCodexContext } from "./codex-context.mjs";
import { loadOrCreateInstallationIdentity } from "./installation-identity.mjs";
import { buildCodexLifecycle,parseLifecycleStatus,terminalLifecycleInput } from "./lifecycle.mjs";

const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_DIAGNOSTIC_CHARACTERS = 2_000;
const MAX_PLAIN_COMPLETION_CHARACTERS = 120;
const MAX_STRUCTURED_COMPLETION_CHARACTERS = 800;
const DRY_RUN_SOURCE_INSTANCE = `codex-notify-${"0".repeat(32)}`;

export class AdapterError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "AdapterError";
    this.exitCode = exitCode;
  }
}

function printable(value, maximum) {
  return Array.from(String(value ?? "")).slice(0, maximum).join("");
}

function computerClass(osPlatform) {
  if (osPlatform === "darwin") return "Mac";
  if (osPlatform === "linux") return "Linux";
  if (osPlatform === "win32") return "Windows";
  return "Computer";
}

function workspaceCorrelation(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return undefined;
  const folder = basename(cwd.trim().replace(/[\\/]+$/gu, ""));
  const project = printable(redactText(folder), 48);
  if (
    !project ||
    /\[(?:credential|path|private key)|(?:token|secret|password|api[_-]?key|credential|private|rm[-_ ]?rf|curl|begin[-_ ]?patch)/iu.test(project)
  ) {
    return "Project";
  }
  return project;
}

export function redactText(value) {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/gu, " [code omitted] ")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/giu, "$1")
    .replace(/https?:\/\/[^\s<>)]+/giu, "[link]")
    .replace(/\b(?:Bearer\s+)?(?:sk[-_]|[a-z][a-z0-9]{1,12}_)[A-Za-z0-9_-]{12,}\b/gu, "[credential redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/giu, "Bearer [credential redacted]")
    .replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "credential=[redacted]")
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*/gu, "[private key omitted]")
    .replace(/(^|\s)(?:\/(?:Users|home|private|var|tmp|etc|Volumes)\/[^\s,;]+)/gu, "$1[path]")
    .replace(/(^|\s)[A-Za-z]:\\[^\s,;]+/gu, "$1[path]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u001B]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function structuredDisplayText(value,depth = 0) {
  if (depth > 3) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.slice(0,3).map((item) => structuredDisplayText(item,depth+1)).filter(Boolean).join(". ");
  }
  if (!value || typeof value !== "object") return "";
  const prose = ["message","summary","title","description","text"]
    .map((key) => structuredDisplayText(value[key],depth+1))
    .filter(Boolean);
  if (prose.length) return [...new Set(prose)].join(". ");
  return structuredDisplayText(value.suggestions,depth+1);
}

function normalizedCompletionText(value) {
  const trimmed = value.trim();
  const jsonShaped = (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (!jsonShaped) return { text: value,structured: false };
  try {
    return { text: structuredDisplayText(JSON.parse(trimmed)),structured: true };
  } catch {
    return { text: "",structured: true };
  }
}

function completionSummary(value) {
  if (typeof value !== "string" || !value.trim()) {
    return { summary: "Open Codex for details.", needsAttention: false };
  }
  const normalized = normalizedCompletionText(value);
  const redacted = redactText(
    normalized.text
      .replace(/\*\*\* Begin Patch[\s\S]*?(?:\*\*\* End Patch|$)/giu, " ")
      .replace(/```[\s\S]*?```/gu, " ")
      .replace(/`[^`\r\n]+`/gu, " ")
      .replace(/^[ \t]*(?:\$|>)\s+.*$/gmu, " "),
  )
    .replace(/\[(?:code omitted|private key omitted|credential redacted|link|path)\]/giu, " ")
    .replace(/credential=\[redacted\]/giu, " ")
    .replace(/(?:^|\s)[#*_~]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!redacted) return { summary: "Open Codex for details.", needsAttention: false };

  const needsAttention =
    /(?:\b(?:blocked|failed|unable|could not|need your (?:input|decision)|waiting for your|please (?:choose|confirm|provide))\b|\?\s*$)/iu.test(
      redacted,
    );
  const displayText = normalized.structured
    ? redacted
    : redacted.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? redacted;
  const maximum = normalized.structured
    ? MAX_STRUCTURED_COMPLETION_CHARACTERS
    : MAX_PLAIN_COMPLETION_CHARACTERS;
  const characters = Array.from(displayText);
  const summary =
    characters.length <= maximum
      ? displayText
      : `${characters.slice(0, maximum-1).join("").trimEnd()}…`;
  return { summary, needsAttention };
}

export function parseCodexPayload(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new AdapterError("Codex notify payload is missing or too large.");
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AdapterError("Codex notify payload is not valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AdapterError("Codex notify payload must be an object.");
  }
  return payload;
}

export function buildNotification(payload, { generic = false, osPlatform = platform() } = {}) {
  if (payload.type !== "agent-turn-complete") return undefined;
  if (
    typeof payload["thread-id"] !== "string" ||
    !payload["thread-id"].trim() ||
    typeof payload["turn-id"] !== "string" ||
    !payload["turn-id"].trim()
  ) {
    throw new AdapterError("Codex completion payload requires non-empty thread-id and turn-id.");
  }
  const workspace = workspaceCorrelation(payload.cwd);
  const computer = computerClass(osPlatform);
  const title = printable(["Codex Auto", computer, workspace].filter(Boolean).join(" · "), 80);
  const completion = completionSummary(payload["last-assistant-message"]);
  const body = `${completion.needsAttention ? "Needs attention" : "Finished"} — ${completion.summary}`;
  const taskTitle = generic ? undefined : "Automatic completion hook";
  const stableIdentity = `${payload["thread-id"]}\u0000${payload["turn-id"]}`;
  const digest = createHash("sha256").update(stableIdentity).digest("hex").slice(0, 40);
  return {
    title,
    body,
    idempotencyKey: `codex-turn:${digest}`,
    computer: computer || undefined,
    project: workspace || undefined,
    taskTitle,
  };
}

export function parseAdapterArgs(argv) {
  const options = { generic: false, dryRun: false, lifecycleOnly: false, notificationFallback: false };
  let payloadArgument;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--generic") options.generic = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--lifecycle-only") options.lifecycleOnly = true;
    else if (argument === "--notification-fallback") options.notificationFallback = true;
    else if (argument === "--relo-bin" || argument === "--chain-config" || argument === "--installation-id-path") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new AdapterError(`${argument} requires a value.`);
      options[{
        "--relo-bin": "reloBin",
        "--chain-config": "chainConfig",
        "--installation-id-path": "installationIdPath",
      }[argument]] = value;
    } else if (argument.startsWith("--")) {
      if (/token|secret|authorization/iu.test(argument)) {
        throw new AdapterError("Credential options are forbidden.");
      }
      throw new AdapterError(`Unknown adapter option: ${argument}`);
    } else if (payloadArgument === undefined) payloadArgument = argument;
    else throw new AdapterError("Expected exactly one Codex JSON payload argument.");
  }
  if (options.lifecycleOnly && options.notificationFallback) {
    throw new AdapterError("Choose --lifecycle-only or --notification-fallback, not both.");
  }
  if (options.lifecycleOnly && !options.installationIdPath) {
    throw new AdapterError("--lifecycle-only requires --installation-id-path.");
  }
  return { ...options, payloadArgument };
}

export function buildChildEnvironment(environment = process.env) {
  const allowed = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "XDG_CONFIG_HOME",
    "RELO_CONFIG_PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (environment[key] === undefined ? [] : [[key, environment[key]]])),
  );
}

function validateCommand(command, label) {
  if (typeof command !== "string" || !isAbsolute(command)) {
    throw new AdapterError(`${label} must be an absolute executable path.`);
  }
  return command;
}

export async function loadChainConfig(path) {
  if (!path) return undefined;
  validateCommand(path, "Chain config path");
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new AdapterError("Unable to read the notifier chain config.");
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new AdapterError("Notifier chain config must be a regular file.");
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new AdapterError("Notifier chain config must have mode 0600.");
  }
  if (process.platform !== "win32" && process.getuid && info.uid !== process.getuid()) {
    throw new AdapterError("Notifier chain config must be owned by the current user.");
  }
  if (info.size > 32 * 1024) throw new AdapterError("Notifier chain config is too large.");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new AdapterError("Unable to read the notifier chain config.");
  }
  if (
    !parsed ||
    !Array.isArray(parsed.nextCommand) ||
    parsed.nextCommand.length < 1 ||
    parsed.nextCommand.some((value) => typeof value !== "string")
  ) {
    throw new AdapterError("Notifier chain config must contain a non-empty nextCommand array.");
  }
  validateCommand(parsed.nextCommand[0], "Chained notifier");
  return parsed.nextCommand;
}

function redactDiagnostic(value) {
  return printable(redactText(value), MAX_DIAGNOSTIC_CHARACTERS);
}

function invoke(spawn, command, args, environment,{
  timeout = 15_000,input,captureStdout = false,
} = {}) {
  const child = spawn(command, args, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe",captureStdout ? "pipe" : "ignore","pipe"],
    ...(input === undefined ? {} : { input }),
    timeout,
    env: buildChildEnvironment(environment),
  });
  if (child.error) return { exitCode: 3, diagnostic: redactDiagnostic(child.error.message) };
  if (child.signal) return { exitCode: 3, diagnostic: `Notifier stopped by ${child.signal}.` };
  return {
    exitCode: Number.isInteger(child.status) ? child.status : 3,
    diagnostic: redactDiagnostic(child.stderr),
    ...(captureStdout ? { stdout: String(child.stdout ?? "") } : {}),
  };
}

export async function execute(argv, dependencies = {}) {
  const parsed = parseAdapterArgs(argv);
  const rawPayload = parsed.payloadArgument;
  const payload = parseCodexPayload(rawPayload);
  const notification = buildNotification(payload, { generic: parsed.generic });
  if (!notification) return { exitCode: 0, skipped: true };

  let lifecycle;
  if (parsed.installationIdPath !== undefined) {
    if (!isAbsolute(parsed.installationIdPath)) {
      throw new AdapterError("Installation identity path must be absolute.");
    }
    const sourceInstance = parsed.dryRun
      ? DRY_RUN_SOURCE_INSTANCE
      : await (dependencies.loadInstallationIdentity ?? loadOrCreateInstallationIdentity)(
        parsed.installationIdPath,
        dependencies.installationIdentityDependencies,
      );
    lifecycle = buildCodexLifecycle(payload,{ sourceInstance,project: notification.project ?? "Project" });
  }

  if (parsed.dryRun) return { exitCode: 0, notification,lifecycle,dryRun: true };
  const reloBin = validateCommand(parsed.reloBin, "Relo binary");
  const accessImpl = dependencies.accessImpl ?? access;
  await accessImpl(reloBin, constants.X_OK).catch(() => {
    throw new AdapterError("Relo binary is not executable.", 3);
  });
  const spawn = dependencies.spawnImpl ?? spawnSync;
  const environment = dependencies.environment ?? process.env;

  const chain = await loadChainConfig(parsed.chainConfig);
  const chainedPayload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": notification.idempotencyKey,
    "turn-id": "completed",
    "input-messages": [],
    "last-assistant-message": notification.body,
  });
  const chainedResult = chain
    ? invoke(spawn, chain[0], [...chain.slice(1), chainedPayload], environment)
    : undefined;

  let lifecycleResult;
  let lifecycleCovered = false;
  let lifecycleMissing = false;
  if (lifecycle) {
    const statusResult = invoke(spawn,reloBin,["activity","status","--stdin","--json"],environment,{
      input: JSON.stringify({ lifecycle: lifecycle.lifecycle }),captureStdout: true,
    });
    lifecycleResult = { statusResult };
    if (statusResult.exitCode === 0) {
      try {
        const status = parseLifecycleStatus(statusResult.stdout);
        if (status.found) {
          lifecycleCovered = true;
          lifecycleResult.status = status;
          if (status.activity.state === "active") {
            lifecycleResult.endResult = invoke(
              spawn,reloBin,[
                "activity","end","--stdin","--idempotency-key",
                lifecycle.completionIdempotencyKey,"--json",
              ],environment,{ input: JSON.stringify(terminalLifecycleInput(lifecycle.lifecycle,notification)) },
            );
          }
        } else {
          lifecycleMissing = true;
        }
      } catch (error) {
        lifecycleResult.statusResult = {
          ...statusResult,exitCode: 3,diagnostic: redactDiagnostic(error.message),
        };
      }
    }
  }

  const lifecycleOnly = parsed.lifecycleOnly || (lifecycle && !parsed.notificationFallback);
  let reloResult;
  if (!lifecycleCovered && !lifecycleOnly) {
    const semanticContext = await (dependencies.resolveCodexContext ?? resolveCodexContext)({
      session_id: payload["thread-id"],
      turn_id: payload["turn-id"],
    },{
      environment: dependencies.environment ?? process.env,
      ...(dependencies.codexContextDependencies ?? {}),
    });
    const notificationContext = {
      ...semanticContext,
      ...(notification.computer ? { computer: notification.computer } : {}),
      ...(notification.project ? { project: notification.project } : {}),
      ...(semanticContext.taskTitle || !notification.taskTitle ? {} : {
        taskTitle: notification.taskTitle,taskTitleSource: "fallback",
      }),
    };
    reloResult = invoke(
      spawn,reloBin,[
        "notify","send",notification.body,"--title",notification.title,"--privacy","standard",
        "--idempotency-key",notification.idempotencyKey,
        "--stdin",
        "--json",
      ],environment,{ input: JSON.stringify({
        context: notificationContext,
        ...(lifecycle ? { origin: lifecycle.origin,lifecycle: lifecycle.lifecycle } : {}),
      }) },
    );
  }
  const lifecycleExit = lifecycleResult?.endResult?.exitCode ?? 0;
  const statusExit = lifecycleResult?.statusResult?.exitCode ?? 0;
  return {
    exitCode: chainedResult?.exitCode || statusExit || lifecycleExit || reloResult?.exitCode || 0,
    chainedResult,
    lifecycleResult,
    reloResult,
    ...(lifecycleOnly && lifecycleMissing ? { skipped: true,skipReason: "lifecycle-not-found" } : {}),
  };
}

export function formatDiagnostic(result) {
  return [
    result.chainedResult?.diagnostic ? `Existing notifier: ${result.chainedResult.diagnostic}` : "",
    result.lifecycleResult?.statusResult?.diagnostic
      ? `Relo lifecycle status: ${result.lifecycleResult.statusResult.diagnostic}` : "",
    result.lifecycleResult?.endResult?.diagnostic
      ? `Relo lifecycle end: ${result.lifecycleResult.endResult.diagnostic}` : "",
    result.reloResult?.diagnostic ? `Relo notifier: ${result.reloResult.diagnostic}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function run(argv, io = {}, dependencies = {}) {
  const stdout = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  return execute(argv, dependencies)
    .then((result) => {
      if (result.dryRun) stdout(JSON.stringify({ ok: true, notification: result.notification }));
      const diagnostic = formatDiagnostic(result);
      if (diagnostic) stderr(diagnostic);
      return result.exitCode;
    })
    .catch((cause) => {
      const error = cause instanceof AdapterError ? cause : new AdapterError("Relo notifier failed.", 3);
      stderr(`${error.name}: ${error.message}`);
      return error.exitCode;
    });
}
