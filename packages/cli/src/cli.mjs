import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseDuration, numberOption, requireText, validateHttpsUrl, validatePublicHttpsUrl } from "./args.mjs";
import { ReloApiClient } from "./api-client.mjs";
import {
  configPath,
  configRevision,
  loadConfig,
  normalizeApiUrl,
  removeConfig,
  writeConfig,
} from "./config.mjs";
import {
  ApiError,
  AuthError,
  EXIT,
  NetworkError,
  ReloError,
  NoDeliveryError,
  TerminalInteractionError,
  UsageError,
  normalizeError,
} from "./errors.mjs";
import {
  expandPermissionTargets,
  inspectPermissionTarget,
  installPermissionTarget,
  restorePermissionSnapshot,
  snapshotPermissionTarget,
  uninstallPermissionTarget,
} from "./permissions.mjs";
import { handleOpenCodeV1Event, runOpenCodeV2Bridge } from "./opencode-bridge.mjs";
import {
  normalizeLifecycleIdentity,normalizeOriginDescriptor,readPrivateOriginFile,
} from "./origin-file.mjs";
import { runDoctor } from "./doctor.mjs";

const VERSION = "0.7.17";

function notificationBody(value) {
  const body = requireText(value, "Notification body", 65_536).replace(/\r\n?/gu, "\n").trim();
  if (Buffer.byteLength(body, "utf8") > 65_536) {
    throw new UsageError("Notification body must be at most 65,536 UTF-8 bytes.");
  }
  return body;
}

function notificationSummary(value) {
  if (value === undefined) return undefined;
  const summary = requireText(value, "summary", 960).replace(/\s+/gu, " ").trim();
  if (Array.from(summary).length > 240) {
    throw new UsageError("Notification summary must be at most 240 characters.");
  }
  return summary;
}
const HELP = `Relo notification client

Usage:
  relo doctor [--smoke] [--json]
  relo auth status [--json]
  relo auth login [--api-url URL] [--client-name NAME] [--scope SCOPE] [--expires-in 90d]
                    [--timeout 10m] [--open|--no-open] [--json]
  relo auth logout [--json]
  relo notify [BODY...] [--title TITLE] [--image URL] [--url URL]
  relo notify send [BODY...] [--title TITLE] [--image URL] [--url URL]
                           [--summary TEXT] [--format text|markdown]
                           [--privacy standard|private] [--device ID...]
                           [--computer NAME] [--project NAME] [--thread-name NAME] [--task-title TEXT]
                           [--idempotency-key KEY] [--stdin]
  relo notify withdraw ID [--idempotency-key KEY]
  relo notify ask [PROMPT] (--type approval|yes-no|text|--approval|--yes-no|--text)
                          [--title TITLE] [--image URL] [--url URL]
                          [--device ID...] [--expires-in 15m]
                          [--live-activity [--style approval|shell|verdict|signal]
                                           [--primary-label LABEL] [--secondary-label LABEL]]
                          [--idempotency-key KEY] [--stdin]
                          [--wait [--timeout 15m]|--poll]
  relo interaction get ID
  relo interaction wait ID [--timeout 60s]
  relo interaction cancel ID
  relo activity start [--name NAME] [--replace] --title TITLE --status TEXT
                        [--detail TEXT] [--progress 0..1] [--progress-label TEXT]
                        [--step LABEL...] [--step-current N]
                        [--symbol terminal|code|build|success|warning]
                        [--style standard|hero|terminal|steps]
                        [--preset automatic|standard|terminal|steps]
                        [--theme system|light|dark]
                        [--accent-color #RRGGBB] [--expires-in 8h] [--stale-after 4h]
                        [--computer NAME] [--project NAME] [--thread-name NAME] [--task-title TEXT]
                        [--device ID...]
                        [--idempotency-key KEY] [--stdin]
  relo activity ensure --title TITLE --status TEXT [--name NAME] [--json]
  relo activity status [--name NAME|--origin-file PATH] [--json]
  relo activity diagnose [ID_OR_NAME|--name NAME] [--wait [--timeout 30s]] [--json]
  relo activity heartbeat --stdin [--lease-after 1h] [--json]
  relo activity wait ACTIVITY_ID [PROMPT] (--type approval|yes-no|text|--approval|--yes-no|--text)
                       [--expires-in 15m] [--primary-label LABEL] [--secondary-label LABEL]
                       [--idempotency-key KEY] [--stdin]
                       [--wait [--timeout 15m]|--poll]
  relo activity update [ID_OR_NAME|--name NAME] [--title TITLE] [--status TEXT]
                            [--detail TEXT|--clear-detail]
                            [--progress 0..1|--clear-progress] [--progress-label TEXT]
                            [--step LABEL...] [--step-current N]
                            [--symbol terminal|code|build|success|warning]
                            [--style standard|hero|terminal|steps]
                            [--preset automatic|standard|terminal|steps]
                            [--accent-color #RRGGBB] [--stale-after 4h] [--if-sequence N]
                            [--computer NAME] [--project NAME] [--thread-name NAME] [--task-title TEXT]
                            [--origin-file PATH] [--idempotency-key KEY] [--stdin]
  relo activity end [ID_OR_NAME|--name NAME] [--status TEXT] [--detail TEXT|--clear-detail]
                         [--progress 0..1|--clear-progress]
                         [--symbol terminal|code|build|success|warning]
                         [--accent-color #RRGGBB] [--dismiss-after 5m]
                         [--origin-file PATH] [--if-sequence N] [--idempotency-key KEY] [--stdin]
  relo activity get ID_OR_NAME|--name NAME
  relo activity list [--limit 1..100]
  relo delivery reconcile JOB_ID mark-accepted|retry|cancel
  relo evidence timeline [--notification ID] [--limit 1..100] [--cursor CURSOR]
  relo evidence metrics
  relo devices list [--page-size 1..100]
  relo services create --title TITLE [--image URL] [--url URL] [--stdin]
                         [--secret-file PATH]
  relo services list
  relo permissions setup [codex|claude|opencode|all]
  relo permissions doctor [codex|claude|opencode|all]
  relo permissions uninstall [codex|claude|opencode|all]

Global options:
  --json   Emit a stable JSON envelope on stdout
  --help   Show this help
  --version Show the installed CLI version

Exit codes:
  0 success/approved/yes/replied   1 API/other failure   2 usage
  3 authentication/scope          4 timeout/canceled/expired
  5 denied/no                     6 network             7 no accepted device

Supplied idempotency keys use 1-200 characters from A-Z, a-z, 0-9, ., _, :, and -.

Credentials are read only from the mode-0600 config file. Token flags are forbidden.`;

const SUCCESS_STATES = new Set(["approved", "yes", "replied", "completed"]);
const NEGATIVE_STATES = new Set(["denied", "no"]);
const CLOSED_STATES = new Set(["canceled", "cancelled", "expired", "timed_out", "timeout"]);
const REQUIRED_PERMISSION_SCOPES = [
  "notifications:send",
  "interactions:create",
  "interactions:read",
];
const DEFAULT_LOGIN_SCOPES = [
  "notifications:send",
  "interactions:create",
  "interactions:read",
  "activities:write",
  "activities:read",
  "devices:read",
  "services:read",
  "services:write",
];
const DEFAULT_DEVICE_PAGE_SIZE = 100;
const MAX_DEVICE_PAGES = 100;
const ALLOWED_LOGIN_SCOPES = new Set([
  ...DEFAULT_LOGIN_SCOPES,
]);
const TASK_ACTIVITY_STYLES = ["standard", "hero", "terminal", "steps"];
const INTERACTIVE_ACTIVITY_STYLES = new Set(["approval", "shell", "verdict", "signal"]);
const ACTIVITY_SYMBOLS = ["terminal", "code", "build", "success", "warning"];
const ACTIVITY_PRESENTATION_PRESETS = ["automatic", "standard", "terminal", "steps"];
const DEFAULT_ACTIVITY_EXPIRES_SECONDS = 28_800;
const DEFAULT_ACTIVITY_STALE_SECONDS = 14_400;
const POLL_TIMEOUT_SECONDS = 20;
const PERMISSION_TIMEOUT_SECONDS = 300;
const MAX_PERMISSION_INPUT_BYTES = 1024 * 1024;
const MAX_STDIN_INPUT_BYTES = 1024 * 1024;
const PERMISSION_AGENTS = Object.freeze({
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
});

function result(command, data, { message } = {}) {
  return { exitCode: EXIT.OK, command, data, message };
}

function assertNoExtra(positionals, expected, usage) {
  if (positionals.length !== expected) throw new UsageError(usage);
}

function assertAtMostOne(positionals, usage) {
  if (positionals.length > 1) throw new UsageError(usage);
}

function assertAllowedOptions(options, allowed) {
  const global = new Set(["help", "json"]);
  for (const [name, value] of Object.entries(options)) {
    if (global.has(name) || allowed.includes(name)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value !== undefined && value !== false) throw new UsageError(`--${name} is not valid for this command`);
  }
}

function joinedText(values) {
  return values.length === 0 ? undefined : values.join(" ");
}

function activityName(options,stdin = {}) {
  const candidates = [options.name,stdin.name]
    .filter((value) => value !== undefined);
  if (candidates.length > 1) throw new UsageError("Use only one of --name or stdin name");
  return optionalText(candidates[0],"Activity name",100);
}

function activityTarget(rest, options, usage) {
  const named = activityName(options);
  if (rest.length > 1 || (rest.length === 1 && named !== undefined)) {
    throw new UsageError(usage);
  }
  return requireText(rest[0] ?? named, "Activity ID or name", 128);
}

function openBrowser(url) {
  const command =
    platform() === "darwin"
      ? { file: "open", args: [url] }
      : platform() === "win32"
        ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

function authFlowError(message, code, exitCode, details) {
  return new ReloError(message, { code, exitCode, details });
}

function safeCredential(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Authorization response did not include credential metadata.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  if (
    typeof value.id !== "string" ||
    typeof value.clientName !== "string" ||
    typeof value.prefix !== "string" ||
    !Array.isArray(value.scopes) ||
    value.scopes.some((scope) => typeof scope !== "string")
  ) {
    throw new ApiError("Authorization response included invalid credential metadata.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  return {
    id: value.id,
    clientName: value.clientName,
    prefix: value.prefix,
    scopes: [...value.scopes],
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.expiresAt === "string" || value.expiresAt === null
      ? { expiresAt: value.expiresAt }
      : {}),
    ...(typeof value.lastUsedAt === "string" || value.lastUsedAt === null
      ? { lastUsedAt: value.lastUsedAt }
      : {}),
    ...(typeof value.revokedAt === "string" || value.revokedAt === null
      ? { revokedAt: value.revokedAt }
      : {}),
  };
}

function validateAuthorizationStart(value, apiUrl) {
  if (
    !value ||
    typeof value.deviceCode !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.deviceCode) ||
    typeof value.userCode !== "string" ||
    !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(
      value.userCode,
    ) ||
    !Number.isInteger(value.expiresInSeconds) ||
    value.expiresInSeconds !== 600 ||
    !Number.isInteger(value.intervalSeconds) ||
    value.intervalSeconds !== 5
  ) {
    throw new ApiError("Device authorization start response was invalid.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  let verificationUri;
  let complete;
  try {
    verificationUri = new URL(value.verificationUri);
    complete = new URL(value.verificationUriComplete);
  } catch {
    throw new ApiError("Device authorization URL was invalid.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  const origin = new URL(apiUrl).origin;
  if (
    verificationUri.origin !== origin ||
    complete.origin !== origin ||
    verificationUri.pathname !== "/cli/authorize" ||
    complete.pathname !== "/cli/authorize" ||
    verificationUri.search ||
    verificationUri.hash ||
    complete.searchParams.get("code") !== value.userCode ||
    [...complete.searchParams.keys()].some((key) => key !== "code") ||
    complete.hash
  ) {
    throw new ApiError("Device authorization URL did not match the configured Relo origin.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  return value;
}

function validateAuthorizationToken(value, requestedScopes, requestedClientName) {
  if (!value || typeof value.accessToken !== "string" || value.accessToken.length < 32) {
    throw new ApiError("Authorization response did not include a valid access token.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  const credential = safeCredential(value.credential);
  if (credential.clientName !== requestedClientName) {
    throw new ApiError("Authorized client name did not match the approved request.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  const received = [...new Set(credential.scopes)].sort();
  if (JSON.stringify(received) !== JSON.stringify(requestedScopes)) {
    throw new ApiError("Authorized scopes did not match the approved request.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  return { accessToken: value.accessToken, credential: { ...credential, scopes: received } };
}

function validateIdempotencyKey(value, generate) {
  const candidate = value ?? `relo-cli:${generate()}`;
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(candidate)) {
    throw new UsageError("--idempotency-key must be 1-200 safe characters");
  }
  return candidate;
}

function enumOption(value, name, allowed, defaultValue) {
  if (value === undefined) return defaultValue;
  if (!allowed.includes(value)) throw new UsageError(`--${name} must be one of: ${allowed.join(", ")}`);
  return value;
}

function taskActivityStyle(value, defaultValue = "standard") {
  if (INTERACTIVE_ACTIVITY_STYLES.has(value)) {
    throw new UsageError(`--style ${value} is reserved for interactive Live Activities`);
  }
  return enumOption(value, "style", TASK_ACTIVITY_STYLES, defaultValue);
}

function definedFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

function detailOption(options) {
  if (options.detail !== undefined && options["clear-detail"]) {
    throw new UsageError("--detail and --clear-detail cannot be used together");
  }
  return options["clear-detail"] ? null : options.detail;
}

function progressOption(options, stdin) {
  if (options.progress !== undefined && options["clear-progress"]) {
    throw new UsageError("--progress and --clear-progress cannot be used together");
  }
  const value = options["clear-progress"] ? null : options.progress ?? stdin.progress;
  return nullableNumberOption(value, "progress", { minimum: 0, maximum: 1 });
}

function semanticStepsOption(options,stdin) {
  const explicitLabels = options.step?.length > 0 ? options.step : undefined;
  const stdinLabels = Array.isArray(stdin.steps)
    ? stdin.steps
    : Array.isArray(stdin.stepLabels) ? stdin.stepLabels : undefined;
  const labels = explicitLabels ?? stdinLabels;
  const currentValue = options["step-current"] ?? stdin.stepCurrent;
  if (labels === undefined && currentValue === undefined) return undefined;
  if (!labels?.length) throw new UsageError("--step-current requires at least one --step label");
  const normalized = labels.map((label) => requireText(label,"step",40));
  if (normalized.length > 8) throw new UsageError("At most 8 --step labels are supported");
  const current = numberOption(currentValue,"step-current",{
    minimum: 1,maximum: normalized.length,integer: true,
  });
  if (current === undefined) throw new UsageError("--step-current is required with --step");
  return { labels: normalized,current };
}

function optionalText(value, label, maximum) {
  if (value === undefined || value === null) return value;
  return requireText(value, label, maximum);
}

function activitySymbol(value, defaultValue) {
  return enumOption(value, "symbol", ACTIVITY_SYMBOLS, defaultValue);
}

function accentColor(value, defaultValue) {
  const candidate = value ?? defaultValue;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || !/^#[0-9a-fA-F]{6}$/.test(candidate)) {
    throw new UsageError("--accent-color must use #RRGGBB format");
  }
  return candidate;
}

function booleanStdin(value, label, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") throw new UsageError(`stdin ${label} must be a boolean`);
  return value;
}

function activityContext(options, stdin) {
  const inherited = stdinContext(stdin.context);
  const context = definedFields({
    providerName: optionalText(inherited.providerName, "providerName", 80),
    producerKind: enumOption(
      inherited.producerKind,
      "producerKind",
      ["agent", "service", "webhook", "manual"],
    ),
    computer:
      options.computer === undefined
        ? optionalText(inherited.computer, "computer", 120)
        : requireText(options.computer, "computer", 120),
    project:
      options.project === undefined
        ? optionalText(inherited.project, "project", 120)
        : requireText(options.project, "project", 120),
    providerThreadId: optionalText(inherited.providerThreadId, "providerThreadId", 200),
    providerWorkItemId: optionalText(inherited.providerWorkItemId, "providerWorkItemId", 200),
    threadName:
      options["thread-name"] === undefined
        ? optionalText(inherited.threadName, "threadName", 160)
        : requireText(options["thread-name"], "thread-name", 160),
    taskTitle:
      options["task-title"] === undefined
        ? optionalText(inherited.taskTitle, "task-title", 160)
        : requireText(options["task-title"], "task-title", 160),
    threadNameSource: enumOption(
      inherited.threadNameSource,
      "threadNameSource",
      ["provider", "explicit", "fallback"],
    ),
    taskTitleSource: enumOption(
      inherited.taskTitleSource,
      "taskTitleSource",
      ["provider", "prompt_summary", "explicit", "fallback"],
    ),
  });
  return Object.keys(context).length > 0 ? context : undefined;
}

async function readStdinJson(stream = process.stdin) {
  let input = "";
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_STDIN_INPUT_BYTES) throw new UsageError("stdin JSON is too large");
    input += chunk;
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new UsageError("stdin must contain valid JSON");
  }
}

async function readPermissionInput(stream = process.stdin) {
  let input = "";
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_PERMISSION_INPUT_BYTES) throw new UsageError("Permission hook input is too large");
    input += chunk;
  }
  const value = JSON.parse(input);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("Permission hook input must be a JSON object");
  }
  return value;
}

async function stdinObject(options, dependencies) {
  if (!options.stdin) return {};
  const value = await dependencies.readStdinJson();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("stdin JSON must be an object");
  }
  return value;
}

async function activityOrigin(options,stdin) {
  if (options["origin-file"] !== undefined && stdin.origin !== undefined) {
    throw new UsageError("Use either --origin-file or stdin origin, not both");
  }
  if (options["origin-file"] !== undefined) return readPrivateOriginFile(options["origin-file"]);
  return stdin.origin === undefined ? undefined : normalizeOriginDescriptor(stdin.origin);
}

function activityLifecycle(stdin) {
  return stdin.lifecycle === undefined ? undefined : normalizeLifecycleIdentity(stdin.lifecycle);
}

async function activityResolver(options,stdin) {
  const origin = await activityOrigin(options,stdin);
  const lifecycle = activityLifecycle(stdin);
  if (origin !== undefined && lifecycle !== undefined) {
    throw new UsageError("Use an origin or lifecycle identity, not both");
  }
  return origin === undefined
    ? lifecycle === undefined ? undefined : { lifecycle }
    : { origin };
}

function stdinDeviceIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new UsageError("stdin deviceIds must be an array");
  return value;
}

function stdinContext(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("stdin context must be an object");
  }
  return value;
}

function nullableNumberOption(value, name, limits) {
  if (value === null) return null;
  return numberOption(value, name, limits);
}

function askType(options, stdin) {
  const aliases = [
    options.approval ? "approval" : undefined,
    options["yes-no"] ? "yes-no" : undefined,
    options.text ? "text" : undefined,
  ].filter(Boolean);
  if (aliases.length > 1 || (aliases.length === 1 && options.type !== undefined)) {
    throw new UsageError(
      "Use exactly one ask response selector: --type, --approval, --yes-no, or --text",
    );
  }
  const value = aliases[0] ?? options.type ?? stdin.type;
  if (!["approval", "yes-no", "yes_no", "text"].includes(value)) {
    throw new UsageError("Ask response type must be one of: approval, yes-no, text");
  }
  return value === "yes-no" ? "yes_no" : value;
}

function askPresentation(options, stdin) {
  if (
    stdin.presentation !== undefined
    && !["notification", "live_activity"].includes(stdin.presentation)
  ) {
    throw new UsageError("stdin presentation must be notification or live_activity");
  }
  return options["live-activity"] || stdin.presentation === "live_activity"
    ? "live_activity"
    : "notification";
}

function interactiveActivityStyle(value) {
  return value === undefined
    ? "approval"
    : enumOption(value, "style", [...INTERACTIVE_ACTIVITY_STYLES]);
}

function actionLabel(value, name) {
  if (value === undefined) return undefined;
  const label = requireText(value, name, 24);
  if (/\r|\n/u.test(label)) {
    throw new UsageError(`${name} must be a single line of 1 to 24 characters`);
  }
  return label;
}

function deliveryGuard(payload) {
  const delivery = payload?.delivery ?? payload;
  if (
    !delivery ||
    !Number.isInteger(delivery.eligibleDevices) ||
    delivery.eligibleDevices < 0 ||
    !Number.isInteger(delivery.durableCommands) ||
    delivery.durableCommands < 0 ||
    !Number.isInteger(delivery.apnsJobs) ||
    delivery.apnsJobs < 0
  ) {
    throw new ApiError("Mutation response did not include a valid delivery summary.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  if (delivery.durableCommands === 0) {
    throw new NoDeliveryError(undefined, {
      eventId: payload?.event?.id ?? payload?.eventId ?? payload?.id,
      eligibleDevices: delivery.eligibleDevices,
      durableCommands: delivery.durableCommands,
    });
  }
  return payload;
}

function interactionState(payload) {
  const interaction = payload?.interaction ?? payload;
  return interaction?.state ?? interaction?.status;
}

function interactionResult(payload) {
  const interaction = payload?.interaction ?? payload;
  const state = interactionState(payload);
  if (SUCCESS_STATES.has(state)) return payload;
  if (NEGATIVE_STATES.has(state) || CLOSED_STATES.has(state)) {
    throw new TerminalInteractionError(`Interaction ended with state: ${state}`, {
      state,
      details: {
        interactionId: interaction?.id,
        result: payload?.interaction === undefined ? { interaction } : payload,
      },
    });
  }
  throw new TerminalInteractionError("Interaction wait ended without a terminal response.", {
    state: "timeout",
    details: {
      interactionId: interaction?.id,
      result: payload?.interaction === undefined ? { interaction } : payload,
    },
  });
}

async function waitForInteraction(client, id, timeoutSeconds, dependencies) {
  const deadline = dependencies.now() + timeoutSeconds * 1_000;
  let latest = { interaction: { id, state: "pending" } };
  while (dependencies.now() < deadline) {
    const startedAt = dependencies.now();
    const remainingSeconds = Math.max(1, Math.ceil((deadline - startedAt) / 1_000));
    const pollSeconds = Math.min(300, remainingSeconds);
    latest = await client.waitForInteraction(id, pollSeconds);
    if (interactionState(latest) !== "pending") return interactionResult(latest);
    if (dependencies.now() >= deadline) break;
    const elapsedMilliseconds = Math.max(0, dependencies.now() - startedAt);
    if (elapsedMilliseconds < pollSeconds * 1_000) {
      await dependencies.sleep(
        Math.min(250, pollSeconds * 1_000 - elapsedMilliseconds, deadline - dependencies.now()),
      );
    }
  }
  return interactionResult(latest);
}

function mergeCreatedAndWaitedInteraction(created, waited) {
  const canonicalInteraction = waited?.interaction ?? waited;
  return {
    ...(waited?.interaction === undefined ? {} : waited),
    ...created,
    interaction: canonicalInteraction,
  };
}

function validateDeviceId(value) {
  return typeof value === "string" && /^dev_[A-Za-z0-9_-]{12,}$/.test(value);
}

function validateCanonicalId(value, prefix) {
  return typeof value === "string" && new RegExp(
    `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    "u",
  ).test(value);
}

function canonicalActivityId(value) {
  if (!validateCanonicalId(value, "act")) {
    throw new UsageError("activity wait requires an exact canonical act_<UUID> ID; keys are not accepted");
  }
  return value;
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validateActivityWaitResponse(value, expected) {
  const interaction = value?.interaction;
  const delivery = value?.delivery;
  const companionExpected = expected.type !== "text";
  const validDeliveryMode = value?.deliveryMode === "queued_for_direct_apns"
    || value?.deliveryMode === "durable_inbox_refresh_only";
  const directDelivery = delivery?.apnsJobs > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.parentActivityId !== expected.parentActivityId
    || (companionExpected
      ? !validateCanonicalId(value.companionActivityId, "act")
        || value.companionActivityId === value.parentActivityId
      : value.companionActivityId !== null)
    || !interaction || typeof interaction !== "object" || Array.isArray(interaction)
    || !validateCanonicalId(interaction.id, "int")
    || !validateCanonicalId(interaction.eventId, "ntf")
    || interaction.eventId !== value.eventId
    || interaction.type !== expected.type
    || interaction.prompt !== expected.prompt
    || typeof interaction.state !== "string" || interaction.state.length === 0
    || !isIsoTimestamp(interaction.expiresAt)
    || !Number.isInteger(value.queued) || value.queued < 0
    || typeof value.replayed !== "boolean"
    || !validDeliveryMode
    || directDelivery !== (value.deliveryMode === "queued_for_direct_apns")) {
    throw new ApiError("Activity wait response was invalid.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  return deliveryGuard({
    parentActivityId: value.parentActivityId,
    companionActivityId: value.companionActivityId,
    interaction: {
      id: interaction.id,
      eventId: interaction.eventId,
      type: interaction.type,
      prompt: interaction.prompt,
      state: interaction.state,
      expiresAt: interaction.expiresAt,
    },
    eventId: value.eventId,
    delivery: {
      eligibleDevices: delivery.eligibleDevices,
      durableCommands: delivery.durableCommands,
      apnsJobs: delivery.apnsJobs,
    },
    queued: value.queued,
    deliveryMode: value.deliveryMode,
    replayed: value.replayed,
  });
}

function invalidDevicePage() {
  return new ApiError("Device list response was invalid.", { code: "INVALID_API_RESPONSE" });
}

async function listAllDevices(client, pageSize = DEFAULT_DEVICE_PAGE_SIZE) {
  const devices = [];
  const deviceIds = new Set();
  const cursors = new Set();
  let cursor;

  for (let page = 0; page < MAX_DEVICE_PAGES; page += 1) {
    const response = await client.listDevices({
      limit: pageSize,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!response || typeof response !== "object" || Array.isArray(response)
      || !Array.isArray(response.devices)
      || response.devices.length > pageSize
      || response.devices.some((device) => !device || typeof device !== "object"
        || Array.isArray(device) || !validateDeviceId(device.deviceId))) {
      throw invalidDevicePage();
    }

    const hasCursor = Object.hasOwn(response, "cursor");
    const hasHasMore = Object.hasOwn(response, "hasMore");
    if (!hasCursor || !hasHasMore
      || typeof response.hasMore !== "boolean"
      || (response.hasMore
        ? typeof response.cursor !== "string" || response.cursor.length === 0
        : response.cursor !== null)
      || (response.hasMore && response.devices.length === 0)) {
      throw invalidDevicePage();
    }

    for (const device of response.devices) {
      if (deviceIds.has(device.deviceId)) throw invalidDevicePage();
      deviceIds.add(device.deviceId);
      devices.push(device);
    }
    if (!response.hasMore) return { devices };
    if (cursors.has(response.cursor)) throw invalidDevicePage();
    cursors.add(response.cursor);
    cursor = response.cursor;
  }
  throw invalidDevicePage();
}

async function resolveTargetDevices(client, values) {
  if (values.length === 0) return undefined;
  if (values.length > 50) throw new UsageError("--device may be specified at most 50 times");
  const malformed = values.filter((value) => !validateDeviceId(value));
  if (malformed.length > 0) {
    throw new UsageError(`Malformed target device ID(s): ${malformed.join(", ")}`);
  }
  const deviceIds = [...new Set(values)];
  const response = await listAllDevices(client);
  const known = new Set(response.devices.map((device) => device.deviceId));
  const unknown = deviceIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown target device ID(s): ${unknown.join(", ")}`);
  }
  return deviceIds;
}

async function getAuthenticated(dependencies) {
  const config = await dependencies.loadConfig(dependencies.configPath());
  const client = dependencies.clientFactory(config);
  return { config, client };
}

async function permissionPrerequisites(dependencies) {
  const { config, client } = await getAuthenticated(dependencies);
  const response = await client.authStatus();
  if (response?.authenticated !== true) {
    throw new AuthError("Relo credential is not authenticated.");
  }
  const scopes = response?.credential?.scopes;
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
    throw new ApiError("Relo auth status did not include valid scopes.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  const missingScopes = REQUIRED_PERMISSION_SCOPES.filter((scope) => !scopes.includes(scope));
  return { config, client, missingScopes };
}

function isReadyResponse(value) {
  return value?.ready === true || value?.status === "ok" || value?.status === "ready";
}

function permissionOptions(dependencies) {
  return {
    home: dependencies.permissionsHome,
    nodePath: dependencies.nodePath,
    entrypoint: dependencies.entrypoint,
    platform: dependencies.platform,
    uid: dependencies.uid,
    runCommand: dependencies.runPermissionCommand,
    beforeCommit: dependencies.beforePermissionCommit,
    probeOpenCodeRuntime: dependencies.probeOpenCodeRuntime,
    env: dependencies.env,
    fetchImpl: dependencies.fetchImpl,
  };
}

function categoricalToolClass(value) {
  const name = typeof value === "string" ? value.toLowerCase() : "";
  if (/bash|shell|exec|command|terminal/.test(name)) return "shell";
  if (/write|edit|patch|replace|notebook/.test(name)) return "file-change";
  if (/read|glob|grep|search|list/.test(name)) return "file-read";
  if (/web|http|fetch|browser|network/.test(name)) return "network";
  if (/task|agent|delegate/.test(name)) return "agent";
  if (/mcp|tool/.test(name)) return "external-tool";
  return "other";
}

function permissionSummary(agent, input) {
  if (!PERMISSION_AGENTS[agent]) throw new UsageError("Unsupported permission hook agent");
  if (agent === "opencode") {
    if (input.hook_event_name !== "permission.ask") {
      throw new UsageError("Unexpected OpenCode permission hook event");
    }
  } else if (input.hook_event_name !== "PermissionRequest") {
    throw new UsageError("Unexpected permission hook event");
  }
  const rawWorkspace = agent === "opencode" ? input.workspace : input.cwd;
  const workspace = createHash("sha256")
    .update(typeof rawWorkspace === "string" && rawWorkspace ? rawWorkspace : "unknown-workspace")
    .digest("hex")
    .slice(0, 12);
  const tool = agent === "opencode" ? input.permission : input.tool_name;
  const requestedCount = agent === "opencode" ? input.resource_count : 1;
  const resourceCount = Number.isInteger(requestedCount)
    ? Math.max(1, Math.min(100, requestedCount))
    : 1;
  return {
    agentClass: PERMISSION_AGENTS[agent],
    toolClass: categoricalToolClass(tool),
    workspace: `ws_${workspace}`,
    resourceCount,
  };
}

function exactInteraction(payload) {
  const interaction = payload?.interaction ?? payload;
  return interaction && typeof interaction === "object" ? interaction : undefined;
}

async function requestPermissionApproval(agent, input, dependencies) {
  const summary = permissionSummary(agent, input);
  const { client, missingScopes } = await permissionPrerequisites(dependencies);
  if (missingScopes.length > 0) {
    throw new AuthError("Relo credential lacks permission approval scopes.", {
      code: "INSUFFICIENT_SCOPE",
      details: { missingScopes },
    });
  }
  const created = deliveryGuard(
    await client.createInteraction(
      {
        title: `${summary.agentClass} permission`,
        prompt: `${summary.agentClass} requests ${summary.toolClass} permission in ${summary.workspace} for ${summary.resourceCount} resource${summary.resourceCount === 1 ? "" : "s"}. Allow once?`,
        type: "approval",
        expiresInSeconds: PERMISSION_TIMEOUT_SECONDS,
      },
      permissionIdempotencyKey(agent, input, dependencies.generateIdempotencyKey),
    ),
  );
  const createdInteraction = exactInteraction(created);
  const id = createdInteraction?.id;
  if (typeof id !== "string" || !id) {
    throw new ApiError("Permission interaction response did not include an ID.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  const waited = await waitForInteraction(client, id, PERMISSION_TIMEOUT_SECONDS, dependencies);
  if (exactInteraction(waited)?.id !== id) {
    throw new ApiError("Permission wait returned a different interaction.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  const canonical = exactInteraction(await client.getInteraction(id));
  if (
    canonical?.id !== id ||
    canonical?.type !== "approval" ||
    canonical?.state !== "approved" ||
    canonical?.action !== "approve" ||
    typeof canonical?.respondingDevice?.id !== "string" ||
    !canonical.respondingDevice.id ||
    typeof canonical?.respondedAt !== "string" ||
    !canonical.respondedAt
  ) {
    throw new TerminalInteractionError("Permission was not explicitly approved.", {
      state: canonical?.state,
    });
  }
  return true;
}

function permissionIdempotencyKey(agent, input, generate) {
  if (agent !== "opencode") {
    const digest = createHash("sha256")
      .update("relo-permission-hook-nonce-v1\0")
      .update(String(generate()))
      .digest("hex");
    return `relo-hook:${agent}:${digest}`;
  }
  const officialIdentityFields = agent === "claude"
    ? ["session_id", "tool_use_id"]
    : agent === "codex"
      ? ["session_id", "turn_id", "tool_call_id"]
      : agent === "opencode"
        ? ["idempotency_key"]
        : [];
  const identity = officialIdentityFields
    .map((name) => [name, input[name]])
    .filter(([, value]) => typeof value === "string" && value.length > 0);
  if (identity.length === 0) return validateIdempotencyKey(undefined, generate);
  const digest = createHash("sha256")
    .update("relo-permission-hook-identity-v1\0")
    .update(JSON.stringify([agent, identity]))
    .digest("hex");
  return `relo-hook:${agent}:${digest}`;
}

function permissionTargetsForPlatform(requestedTarget, platformName) {
  const targets = expandPermissionTargets(requestedTarget);
  if (requestedTarget !== undefined && requestedTarget !== "all") {
    return { targets, skipped: [] };
  }
  if (platformName === "darwin") return { targets, skipped: [] };
  return {
    targets: targets.filter((target) => target !== "opencode"),
    skipped: [
      {
        target: "opencode",
        reason: "OpenCode permission setup currently requires macOS.",
      },
    ],
  };
}

async function assertSecretFileAvailable(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new UsageError("--secret-file requires a path");
  }
  try {
    const existing = await lstat(path);
    const kind = existing.isSymbolicLink() ? "symlink" : existing.isFile() ? "file" : "non-regular path";
    throw new UsageError(`Refusing to overwrite an existing ${kind} with --secret-file`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function reserveSecretFile(path) {
  await assertSecretFileAvailable(path);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    if (process.platform !== "win32") await handle.chmod(0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      throw new UsageError("Refusing a --secret-file path that appeared during reservation");
    }
    throw error;
  }
  const info = await handle.stat();
  return {
    path,
    handle,
    identity: { dev: info.dev, ino: info.ino },
  };
}

function sameFile(info, identity) {
  return info.dev === identity.dev && info.ino === identity.ino;
}

async function assertReservationPathIdentity(reservation, message) {
  try {
    const current = await lstat(reservation.path);
    if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, reservation.identity)) {
      throw new UsageError(message);
    }
  } catch (error) {
    if (error?.code === "ENOENT") throw new UsageError(message);
    throw error;
  }
}

async function releaseSecretFileReservation(reservation) {
  await reservation.handle?.close().catch(() => {});
}

async function writeReservedSecretFile(reservation, webhookUrl) {
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new ApiError("Service creation response did not include a valid webhook URL.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ApiError("Service creation response did not include a valid webhook URL.", {
      code: "INVALID_API_RESPONSE",
    });
  }

  const contents = Buffer.from(parsed.toString(), "utf8");
  if (contents.length === 0 || contents.length > 4_096) {
    throw new ApiError("Service creation response did not include a valid webhook URL.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  let wrote = false;
  try {
    const current = await reservation.handle.stat();
    if (
      !current.isFile() || current.isSymbolicLink()
      || !sameFile(current, reservation.identity) || current.nlink !== 1 || current.size !== 0
    ) {
      throw new UsageError("Refusing to write a changed --secret-file reservation");
    }
    await assertReservationPathIdentity(
      reservation,
      "Refusing to write a changed --secret-file reservation",
    );
    const result = await reservation.handle.write(contents, 0, contents.length, 0);
    wrote = true;
    if (result.bytesWritten !== contents.length) {
      throw new ApiError("The service secret file write was incomplete.", {
        code: "SECRET_FILE_WRITE_FAILED",
      });
    }
    await reservation.handle.sync();
    await assertReservationPathIdentity(
      reservation,
      "Refusing a changed --secret-file after writing",
    );
    const finalReservation = await reservation.handle.stat();
    if (
      !finalReservation.isFile() || finalReservation.isSymbolicLink()
      || !sameFile(finalReservation, reservation.identity)
      || finalReservation.nlink !== 1 || finalReservation.size !== contents.length
    ) {
      throw new UsageError("Refusing a changed --secret-file after writing");
    }
  } catch (error) {
    if (wrote) {
      await reservation.handle.truncate(0).catch(() => {});
      await reservation.handle.sync().catch(() => {});
    }
    throw error;
  }
}

async function revokeCreatedService(client, created) {
  const id = created?.service?.id;
  if (typeof id !== "string" || id.length === 0 || typeof client.revokeService !== "function") return false;
  try {
    await client.revokeService(id);
    return true;
  } catch {
    return false;
  }
}

function permissionHookOutput(agent, allowed) {
  if (agent === "opencode") {
    return { agent: "opencode", decision: allowed ? "allow_once" : "deny", allowOnce: allowed };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: allowed ? "allow" : "deny",
        ...(allowed ? {} : { message: "Relo phone approval was not granted." }),
      },
    },
  };
}

async function runPermissionHook(agent, io, overrides) {
  const stdout = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  let allowed = false;
  try {
    if (!PERMISSION_AGENTS[agent]) throw new UsageError("Unsupported permission hook agent");
    const dependencies = createDependencies(overrides);
    const input = await (overrides.readPermissionInput ?? readPermissionInput)();
    allowed = await requestPermissionApproval(agent, input, dependencies);
  } catch {
    allowed = false;
  }
  stdout(JSON.stringify(permissionHookOutput(agent, allowed)));
  return EXIT.OK;
}

async function revokeIssuedCredential(apiUrl, accessToken, dependencies) {
  if (typeof accessToken !== "string" || accessToken.length < 32) return;
  try {
    await dependencies.clientFactory({ apiUrl, token: accessToken }).revokeAuth();
  } catch {
    // The original failure remains authoritative; never expose the issued token in diagnostics.
  }
}

async function login(options, dependencies) {
  if (options.open && options["no-open"]) {
    throw new UsageError("--open and --no-open cannot be used together");
  }
  const clientName = requireText(options["client-name"] ?? "Relo CLI", "--client-name", 80);
  const scopes = [
    ...new Set(options.scope.length > 0 ? options.scope : DEFAULT_LOGIN_SCOPES),
  ].sort();
  const unknownScopes = scopes.filter((scope) => !ALLOWED_LOGIN_SCOPES.has(scope));
  if (unknownScopes.length > 0) {
    throw new UsageError(`Unknown Relo scope: ${unknownScopes.join(", ")}`);
  }
  const expiresInSeconds = parseDuration(options["expires-in"] ?? "90d", {
    minimumSeconds: 3_600,
    maximumSeconds: 31_536_000,
  });
  const timeoutSeconds = parseDuration(options.timeout ?? "10m", {
    maximumSeconds: 600,
  });
  let trustedOrigin = options["api-url"] ?? dependencies.env.RELO_API_URL;
  if (trustedOrigin === undefined) {
    try {
      trustedOrigin = (await dependencies.loadConfig(dependencies.configPath())).apiUrl;
    } catch (error) {
      if (!(error instanceof AuthError && error.code === "CONFIG_NOT_FOUND")) throw error;
    }
  }
  if (trustedOrigin === undefined) {
    throw new UsageError(
      "Relo server origin is required; use --api-url or RELO_API_URL for first-time login",
    );
  }
  const apiUrl = normalizeApiUrl(trustedOrigin);
  const path = dependencies.configPath();
  const expectedConfigRevision = await dependencies.configRevision(path);
  const client = dependencies.clientFactory({ apiUrl });
  const started = validateAuthorizationStart(
    await client.startDeviceAuthorization({ clientName, scopes, expiresInSeconds }),
    apiUrl,
  );

  dependencies.stderr("Open this link to connect the Relo CLI:");
  dependencies.stderr(started.verificationUriComplete);
  dependencies.stderr(`Fallback page: ${started.verificationUri}`);
  dependencies.stderr(`Fallback code: ${started.userCode}`);
  const shouldOpen = options.open || (!options["no-open"] && dependencies.stderrIsTTY);
  if (shouldOpen) {
    try {
      dependencies.openBrowser(started.verificationUriComplete);
    } catch (error) {
      dependencies.stderr(
        `Could not open browser: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  const deadline =
    dependencies.now() + Math.min(timeoutSeconds, started.expiresInSeconds) * 1_000;
  let intervalSeconds = started.intervalSeconds;
  while (dependencies.now() < deadline) {
    await dependencies.sleep(
      Math.min(intervalSeconds * 1_000, Math.max(0, deadline - dependencies.now())),
    );
    if (dependencies.now() >= deadline) break;

    let response;
    try {
      response = await client.pollDeviceAuthorization(started.deviceCode);
    } catch (error) {
      if (error instanceof NetworkError || (error instanceof ApiError && error.status >= 500)) {
        continue;
      }
      if (!(error instanceof ApiError)) throw error;
      const code = error.code.toLowerCase();
      if (code === "authorization_pending") {
        intervalSeconds = Math.max(
          intervalSeconds,
          Number(error.details?.intervalSeconds) || intervalSeconds,
        );
        continue;
      }
      if (code === "slow_down" || code === "rate_limited") {
        const serverInterval = Number(error.details?.intervalSeconds) || 0;
        const retryAfter = Number(error.details?.retryAfterSeconds) || 0;
        intervalSeconds = Math.max(
          intervalSeconds + (code === "slow_down" ? 5 : 0),
          serverInterval,
          retryAfter,
        );
        continue;
      }
      if (code === "access_denied") {
        throw authFlowError("Authorization was denied.", "ACCESS_DENIED", EXIT.NEGATIVE);
      }
      if (code === "expired_token") {
        throw authFlowError("Authorization expired.", "AUTHORIZATION_EXPIRED", EXIT.TERMINAL);
      }
      if (code === "invalid_grant") {
        throw new AuthError("Authorization grant is no longer valid.", {
          code: "INVALID_GRANT",
        });
      }
      throw error;
    }

    const accessToken = response?.accessToken;
    try {
      const issued = validateAuthorizationToken(response, scopes, clientName);
      await dependencies.writeConfig(path, {
        version: 1,
        apiUrl,
        token: issued.accessToken,
        principal: {
          id: issued.credential.id,
          name: issued.credential.clientName,
          scopes: issued.credential.scopes,
          expiresAt: issued.credential.expiresAt ?? null,
        },
      }, { expectedRevision: expectedConfigRevision });
      return result("auth.login", {
        authenticated: true,
        apiUrl,
        credential: issued.credential,
        configPath: path,
      });
    } catch (error) {
      await revokeIssuedCredential(apiUrl, accessToken, dependencies);
      throw error;
    }
  }
  throw authFlowError(
    "Authorization timed out.",
    "AUTHORIZATION_TIMEOUT",
    EXIT.TERMINAL,
  );
}

async function executeCommand(parsed, dependencies) {
  const { positionals, options } = parsed;
  if (options.version) {
    if (positionals.length > 0) throw new UsageError("--version cannot be combined with a command");
    assertAllowedOptions(options, ["version"]);
    return result("version", { version: VERSION });
  }
  if (options.help || positionals.length === 0) return result("help", { help: HELP });
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

  if (group === "auth" && action === "status") {
    assertNoExtra(rest, 0, "Usage: relo auth status");
    assertAllowedOptions(options, []);
    const { config, client } = await getAuthenticated(dependencies);
    const response = await client.authStatus();
    if (response?.authenticated !== true) {
      throw new AuthError("Relo credential is not authenticated.");
    }
    return result("auth.status", {
      authenticated: true,
      apiUrl: config.apiUrl,
      credential: safeCredential(response.credential),
      configPath: config.path,
    });
  }

  if (group === "auth" && action === "login") {
    assertNoExtra(rest, 0, "Usage: relo auth login [options]");
    assertAllowedOptions(options, [
      "api-url",
      "client-name",
      "scope",
      "expires-in",
      "timeout",
      "open",
      "no-open",
    ]);
    return login(options, dependencies);
  }

  if (group === "auth" && action === "logout") {
    assertNoExtra(rest, 0, "Usage: relo auth logout");
    assertAllowedOptions(options, []);
    const path = dependencies.configPath();
    let config;
    try {
      config = await dependencies.loadConfig(path);
    } catch (error) {
      if (error instanceof AuthError && error.code === "CONFIG_NOT_FOUND") {
        return result("auth.logout", {
          authenticated: false,
          revoked: false,
          credentialsRemoved: false,
          alreadyLoggedOut: true,
        });
      }
      throw error;
    }
    let revoked = false;
    let revocationError;
    try {
      const response = await dependencies.clientFactory(config).revokeAuth();
      revoked = response?.revoked === true;
    } catch (error) {
      revocationError = normalizeError(error).code;
    }
    const credentialsRemoved = await dependencies.removeConfig(path, {
      expectedRevision: config.revision,
    });
    return result(
      "auth.logout",
      {
        authenticated: false,
        revoked,
        credentialsRemoved,
        serverRevocation: revoked ? "confirmed" : "unconfirmed",
        ...(revocationError ? { revocationError } : {}),
      },
      revoked
        ? undefined
        : {
            message:
              "Local Relo credentials were removed, but server revocation is unconfirmed; revoke this client in the dashboard.",
          },
    );
  }

  if (group === "permissions" && action === "uninstall") {
    assertAtMostOne(rest, "Usage: relo permissions uninstall [target|all]");
    assertAllowedOptions(options, []);
    const targets = expandPermissionTargets(rest[0]);
    const removed = [];
    for (const target of targets) {
      removed.push(await uninstallPermissionTarget(target, permissionOptions(dependencies)));
    }
    return result("permissions.uninstall", { targets: removed });
  }

  if (group === "permissions" && action === "setup") {
    assertAtMostOne(rest, "Usage: relo permissions setup [target|all]");
    assertAllowedOptions(options, []);
    if (dependencies.platform === "win32") {
      throw new ApiError("Permission bridge setup currently supports macOS and Linux.", {
        code: "UNSUPPORTED_PLATFORM",
      });
    }
    const { targets, skipped } = permissionTargetsForPlatform(
      rest[0],
      dependencies.platform,
    );
    const { client, missingScopes } = await permissionPrerequisites(dependencies);
    if (missingScopes.length > 0) {
      throw new AuthError("Relo credential lacks permission approval scopes.", {
        code: "INSUFFICIENT_SCOPE",
        details: { missingScopes },
      });
    }
    const ready = await client.ready();
    if (!isReadyResponse(ready)) {
      throw new ApiError("Relo server is not ready.", { code: "SERVER_NOT_READY" });
    }
    const preflight = await Promise.all(
      targets.map((target) => inspectPermissionTarget(target, permissionOptions(dependencies))),
    );
    const conflict = preflight.find((check) =>
      ["invalid", "unsafe", "occupied-by-unmanaged-file"].includes(check.state),
    );
    if (conflict) {
      throw new ApiError(`Cannot install Relo permission adapter: ${conflict.state}.`, {
        code: "HOOK_CONFIG_CONFLICT",
        details: { target: conflict.path },
      });
    }
    const snapshots = await Promise.all(
      targets.map((target) => snapshotPermissionTarget(target, permissionOptions(dependencies))),
    );
    const installed = [];
    try {
      for (const target of targets) {
        installed.push(await installPermissionTarget(target, permissionOptions(dependencies)));
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const snapshot of [...snapshots].reverse()) {
        try {
          await restorePermissionSnapshot(snapshot, permissionOptions(dependencies));
        } catch (rollbackError) {
          const normalized = normalizeError(rollbackError);
          rollbackErrors.push({
            target: snapshot.target,
            code: normalized.code,
            ...(normalized.details ? { details: normalized.details } : {}),
          });
        }
      }
      if (rollbackErrors.length > 0) {
        throw new ApiError("Permission setup failed and rollback was incomplete.", {
          code: "PERMISSION_SETUP_ROLLBACK_FAILED",
          details: { rollbackErrors },
          cause: error,
        });
      }
      throw error;
    }
    return result(
      "permissions.setup",
      { targets: installed, ...(skipped.length > 0 ? { skipped } : {}) },
      {
        message: [
          targets.includes("codex")
            ? "Review and trust the Relo hook in Codex /hooks before relying on it."
            : undefined,
          ...skipped.map((item) => item.reason),
        ].filter(Boolean).join(" ") || undefined,
      },
    );
  }

  if (group === "permissions" && action === "doctor") {
    assertAtMostOne(rest, "Usage: relo permissions doctor [target|all]");
    assertAllowedOptions(options, []);
    const { targets, skipped } = permissionTargetsForPlatform(
      rest[0],
      dependencies.platform,
    );
    const { config, client, missingScopes } = await permissionPrerequisites(dependencies);
    let server;
    try {
      server = await client.ready();
    } catch (error) {
      server = { ready: false, error: normalizeError(error).code };
    }
    const targetChecks = await Promise.all(
      targets.map((target) => inspectPermissionTarget(target, permissionOptions(dependencies))),
    );
    const checks = {
      config: { ok: true, path: config.path, secure: true },
      auth: { ok: true, status: "authenticated" },
      scopes: {
        ok: missingScopes.length === 0,
        required: REQUIRED_PERMISSION_SCOPES,
        missing: missingScopes,
      },
      server: {
        ok: isReadyResponse(server),
        status: server?.status ?? (isReadyResponse(server) ? "ready" : "unavailable"),
        ...(server?.error ? { error: server.error } : {}),
      },
      hooks: {
        ok: targetChecks.every((check) => check.installed),
        targets: targetChecks,
        ...(skipped.length > 0 ? { skipped } : {}),
      },
    };
    const ok = checks.scopes.ok && checks.server.ok && checks.hooks.ok;
    return {
      exitCode: ok ? EXIT.OK : EXIT.API,
      command: "permissions.doctor",
      data: { ok, checks },
      message: ok
        ? "Relo permission adapters are installed; Codex trust remains a manual review step."
        : "Relo permission setup needs attention.",
    };
  }

  const { config, client } = await getAuthenticated(dependencies);

  if (group === "notify" && action === "send") {
    assertAllowedOptions(options, [
      "title",
      "summary",
      "format",
      "image",
      "url",
      "device",
      "idempotency-key",
      "computer",
      "project",
      "thread-name",
      "task-title",
      "stdin",
    ]);
    const stdin = await stdinObject(options, dependencies);
    const sourceName = config.principal?.name ?? config.principal?.displayName ?? "Relo";
    const deviceIds = await resolveTargetDevices(
      client,
      options.device.length > 0 ? options.device : stdinDeviceIds(stdin.deviceIds),
    );
    const inheritedContext = stdinContext(stdin.context);
    const context = definedFields({
      providerName: optionalText(inheritedContext.providerName, "providerName", 80),
      producerKind: enumOption(
        inheritedContext.producerKind,
        "producerKind",
        ["agent", "service", "webhook", "manual"],
      ),
      computer:
        options.computer === undefined
          ? optionalText(inheritedContext.computer, "computer", 120)
          : requireText(options.computer, "computer", 120),
      project:
        options.project === undefined
          ? optionalText(inheritedContext.project, "project", 120)
          : requireText(options.project, "project", 120),
      providerThreadId: optionalText(inheritedContext.providerThreadId, "providerThreadId", 200),
      providerWorkItemId: optionalText(inheritedContext.providerWorkItemId, "providerWorkItemId", 200),
      threadName:
        options["thread-name"] === undefined
          ? optionalText(inheritedContext.threadName, "threadName", 160)
          : requireText(options["thread-name"], "thread-name", 160),
      taskTitle:
        options["task-title"] === undefined
          ? optionalText(inheritedContext.taskTitle, "task-title", 160)
          : requireText(options["task-title"], "task-title", 160),
      threadNameSource: enumOption(
        inheritedContext.threadNameSource,
        "threadNameSource",
        ["provider", "explicit", "fallback"],
      ),
      taskTitleSource: enumOption(
        inheritedContext.taskTitleSource,
        "taskTitleSource",
        ["provider", "prompt_summary", "explicit", "fallback"],
      ),
    });
    const body = definedFields({
      body: notificationBody(joinedText(rest) ?? stdin.body),
      summary: notificationSummary(options.summary ?? stdin.summary),
      bodyFormat: enumOption(options.format ?? stdin.bodyFormat, "format", ["text", "markdown"]),
      title: requireText(options.title ?? stdin.title ?? sourceName, "Title", 80),
      sourceName,
      imageUrl: validatePublicHttpsUrl(options.image ?? stdin.imageUrl, "image"),
      destinationUrl: validateHttpsUrl(
        options.url ?? stdin.destinationUrl ?? stdin.url,
        "url",
      ),
      deviceIds,
      ...(Object.values(context).some((value) => value !== undefined) ? { context } : {}),
      origin: stdin.origin === undefined ? undefined : normalizeOriginDescriptor(stdin.origin),
    });
    const data = deliveryGuard(
      await client.sendNotification(
        body,
        validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey),
      ),
    );
    return result("notify.send", data);
  }

  if (group === "notify" && action === "withdraw") {
    assertAtMostOne(rest, "Usage: relo notify withdraw ID [--idempotency-key KEY]");
    assertAllowedOptions(options, ["idempotency-key"]);
    const id = requireText(rest[0], "Notification ID", 100);
    const data = await client.withdrawNotification(
      id,
      validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey),
    );
    return result("notify.withdraw", data);
  }

  if (group === "notify" && action === "ask") {
    assertAllowedOptions(options, [
      "type",
      "approval",
      "yes-no",
      "text",
      "title",
      "expires-in",
      "timeout",
      "wait",
      "device",
      "idempotency-key",
      "stdin",
      "poll",
      "live-activity",
      "style",
      "primary-label",
      "secondary-label",
      "image",
      "url",
    ]);
    if (options.poll && (options.wait || options.timeout !== undefined)) {
      throw new UsageError("--poll cannot be combined with --wait or --timeout");
    }
    if (options.timeout !== undefined && !options.wait) {
      throw new UsageError("--timeout requires --wait");
    }
    const stdin = await stdinObject(options, dependencies);
    const type = askType(options, stdin);
    const presentation = askPresentation(options, stdin);
    const liveActivity = presentation === "live_activity";
    const imageUrl = validatePublicHttpsUrl(options.image ?? stdin.imageUrl, "image");
    const destinationUrl = validateHttpsUrl(
      options.url ?? stdin.destinationUrl ?? stdin.url,
      "url",
    );
    if (liveActivity && (imageUrl !== undefined || destinationUrl !== undefined)) {
      throw new UsageError("--image and --url are supported only for ordinary notification asks");
    }
    const styleValue = options.style ?? stdin.style;
    const primaryLabelValue = options["primary-label"] ?? stdin.primaryLabel;
    const secondaryLabelValue = options["secondary-label"] ?? stdin.secondaryLabel;
    if (!liveActivity && styleValue !== undefined) {
      throw new UsageError("interactive --style requires --live-activity");
    }
    if (!liveActivity && (primaryLabelValue !== undefined || secondaryLabelValue !== undefined)) {
      throw new UsageError("custom action labels require --live-activity");
    }
    if (liveActivity && type === "text") {
      throw new UsageError("--live-activity supports --approval or --yes-no, not --text");
    }
    const expiresInSeconds = parseDuration(
      options["expires-in"] ?? stdin.expiresInSeconds,
      {
        defaultSeconds: 900,
        minimumSeconds: 30,
        maximumSeconds: liveActivity ? 28_800 : 86_400,
      },
    );
    const timeoutSeconds = options.poll
      ? POLL_TIMEOUT_SECONDS
      : options.wait
        ? parseDuration(options.timeout, {
            defaultSeconds: expiresInSeconds,
            maximumSeconds: 86_400,
          })
        : undefined;
    const deviceIds = await resolveTargetDevices(
      client,
      options.device.length > 0 ? options.device : stdinDeviceIds(stdin.deviceIds),
    );
    const data = deliveryGuard(
      await client.createInteraction(
        definedFields({
          prompt: requireText(
            joinedText(rest) ?? stdin.prompt,
            "Interaction prompt",
            liveActivity ? 240 : 2_000,
          ),
          type,
          title:
            options.title === undefined
              ? optionalText(stdin.title, "Title", 80)
              : requireText(options.title, "Title", 80),
          expiresInSeconds,
          deviceIds,
          imageUrl,
          destinationUrl,
          ...(liveActivity ? { presentation } : {}),
          style: liveActivity ? interactiveActivityStyle(styleValue) : undefined,
          primaryLabel: liveActivity ? actionLabel(primaryLabelValue, "primary-label") : undefined,
          secondaryLabel: liveActivity
            ? actionLabel(secondaryLabelValue, "secondary-label")
            : undefined,
        }),
        validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey),
      ),
    );
    if (!options.wait && !options.poll) return result("notify.ask", data);
    const id = data?.interaction?.id ?? data?.id;
    if (!id) {
      throw new ApiError("Interaction response did not include an ID.", {
        code: "INVALID_API_RESPONSE",
      });
    }
    try {
      const waited = await waitForInteraction(client, id, timeoutSeconds, dependencies);
      return result("notify.ask", mergeCreatedAndWaitedInteraction(data, waited));
    } catch (error) {
      if (!(error instanceof TerminalInteractionError)) throw error;
      const { state, result: waitedResult, ...details } = error.details ?? {};
      throw new TerminalInteractionError(error.message, {
        state,
        details: {
          ...details,
          result: mergeCreatedAndWaitedInteraction(data, waitedResult),
        },
      });
    }
  }

  if (group === "interaction" && action === "get") {
    assertNoExtra(rest, 1, "Usage: relo interaction get ID");
    assertAllowedOptions(options, []);
    const data = await client.getInteraction(rest[0]);
    return result(
      "interaction.get",
      interactionState(data) === "pending" ? data : interactionResult(data),
    );
  }

  if (group === "interaction" && action === "wait") {
    assertNoExtra(rest, 1, "Usage: relo interaction wait ID [--timeout 60s]");
    assertAllowedOptions(options, ["timeout"]);
    const timeoutSeconds = parseDuration(options.timeout, { defaultSeconds: 60, maximumSeconds: 3_600 });
    return result(
      "interaction.wait",
      await waitForInteraction(client, rest[0], timeoutSeconds, dependencies),
    );
  }

  if (group === "interaction" && action === "cancel") {
    assertNoExtra(rest, 1, "Usage: relo interaction cancel ID");
    assertAllowedOptions(options, []);
    return result("interaction.cancel", await client.cancelInteraction(rest[0]));
  }

  if (group === "delivery" && action === "reconcile") {
    assertNoExtra(rest, 2, "Usage: relo delivery reconcile JOB_ID mark-accepted|retry|cancel");
    assertAllowedOptions(options, []);
    const deliveryId = requireText(rest[0], "Delivery job ID", 80);
    if (!/^job_[A-Za-z0-9-]{12,64}$/u.test(deliveryId)) {
      throw new UsageError("Delivery job ID must use the public job_ identifier.");
    }
    const reconciliationAction = enumOption(
      requireText(rest[1], "Reconciliation action", 32),
      "reconciliation action",
      ["mark-accepted", "retry", "cancel"],
    ).replace("-", "_");
    return result(
      "delivery.reconcile",
      await client.reconcileDelivery(deliveryId, reconciliationAction),
    );
  }

  if (group === "evidence" && action === "timeline") {
    assertNoExtra(rest, 0, "Usage: relo evidence timeline [--notification ID] [--limit 1..100] [--cursor CURSOR]");
    assertAllowedOptions(options, ["notification", "limit", "cursor"]);
    const notificationId = options.notification === undefined
      ? undefined
      : requireText(options.notification, "Notification ID", 80);
    if (notificationId !== undefined && !/^ntf_[A-Za-z0-9-]{12,64}$/u.test(notificationId)) {
      throw new UsageError("Notification ID must use the public ntf_ identifier.");
    }
    const limit = numberOption(options.limit, "limit", {
      minimum: 1,maximum: 100,integer: true,
    });
    const cursor = options.cursor === undefined
      ? undefined
      : requireText(options.cursor, "Evidence cursor", 2_000);
    return result(
      "evidence.timeline",
      await client.getEvidenceTimeline({ notificationId,limit,cursor }),
    );
  }

  if (group === "evidence" && action === "metrics") {
    assertNoExtra(rest, 0, "Usage: relo evidence metrics");
    assertAllowedOptions(options, []);
    return result("evidence.metrics",await client.getEvidenceMetrics());
  }

  if (group === "activity" && action === "wait") {
    if (rest.length < 1) {
      throw new UsageError("Usage: relo activity wait ACTIVITY_ID [PROMPT] [options]");
    }
    assertAllowedOptions(options, [
      "type",
      "approval",
      "yes-no",
      "text",
      "expires-in",
      "timeout",
      "wait",
      "idempotency-key",
      "stdin",
      "poll",
      "primary-label",
      "secondary-label",
    ]);
    if (options.poll && (options.wait || options.timeout !== undefined)) {
      throw new UsageError("--poll cannot be combined with --wait or --timeout");
    }
    if (options.timeout !== undefined && !options.wait) {
      throw new UsageError("--timeout requires --wait");
    }
    const parentActivityId = canonicalActivityId(rest[0]);
    const stdin = await stdinObject(options, dependencies);
    const type = askType(options, stdin);
    const primaryLabelValue = options["primary-label"] ?? stdin.primaryLabel;
    const secondaryLabelValue = options["secondary-label"] ?? stdin.secondaryLabel;
    if (type === "text" && (primaryLabelValue !== undefined || secondaryLabelValue !== undefined)) {
      throw new UsageError("activity text waits do not support action labels");
    }
    const prompt = requireText(
      joinedText(rest.slice(1)) ?? stdin.prompt,
      "Interaction prompt",
      type === "text" ? 2_000 : 240,
    );
    const expiresInSeconds = parseDuration(
      options["expires-in"] ?? stdin.expiresInSeconds,
      { defaultSeconds: 900, minimumSeconds: 30, maximumSeconds: 28_800 },
    );
    const timeoutSeconds = options.poll
      ? POLL_TIMEOUT_SECONDS
      : options.wait
        ? parseDuration(options.timeout, {
            defaultSeconds: expiresInSeconds,
            maximumSeconds: 28_800,
          })
        : undefined;
    const body = definedFields({
      type,
      prompt,
      expiresInSeconds,
      primaryLabel: type === "text" ? undefined : actionLabel(primaryLabelValue, "primary-label"),
      secondaryLabel: type === "text"
        ? undefined
        : actionLabel(secondaryLabelValue, "secondary-label"),
    });
    const data = validateActivityWaitResponse(
      await client.createActivityWait(
        parentActivityId,
        body,
        validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey),
      ),
      { parentActivityId, type, prompt },
    );
    if (!options.wait && !options.poll) return result("activity.wait", data);
    const id = data.interaction.id;
    try {
      const waited = await waitForInteraction(client, id, timeoutSeconds, dependencies);
      return result("activity.wait", mergeCreatedAndWaitedInteraction(data, waited));
    } catch (error) {
      if (!(error instanceof TerminalInteractionError)) throw error;
      const { state, result: waitedResult, ...details } = error.details ?? {};
      throw new TerminalInteractionError(error.message, {
        state,
        details: {
          ...details,
          result: mergeCreatedAndWaitedInteraction(data, waitedResult),
        },
      });
    }
  }

  if (group === "activity" && (action === "start" || action === "ensure")) {
    assertNoExtra(rest, 0, `Usage: relo activity ${action} [--name NAME] --title TITLE --status TEXT [options]`);
    assertAllowedOptions(options, [
      "name",
      "replace",
      "title",
      "status",
      "detail",
      "progress",
      "progress-label",
      "step",
      "step-current",
      "symbol",
      "style",
      "preset",
      "theme",
      "accent-color",
      "expires-in",
      "stale-after",
      "device",
      "idempotency-key",
      "computer",
      "project",
      "thread-name",
      "task-title",
      "origin-file",
      "stdin",
    ]);
    const stdin = await stdinObject(options, dependencies);
    const origin = await activityOrigin(options,stdin);
    const lifecycle = activityLifecycle(stdin);
    const manualKey = activityName(options,stdin);
    if (origin !== undefined && manualKey !== undefined) {
      throw new UsageError("Use lifecycle origin or a manual key, not both");
    }
    const requestedStyle = options.style ?? stdin.style;
    const progress = numberOption(options.progress ?? stdin.progress, "progress", {
      minimum: 0,maximum: 1,
    });
    const progressLabel = optionalText(
      options["progress-label"] ?? stdin.progressLabel,"progress-label",32,
    );
    if (progressLabel !== undefined && progress === undefined) {
      throw new UsageError("--progress-label requires --progress when starting an activity");
    }
    const body = definedFields({
      key: manualKey,
      acquireMode: action === "ensure" ? "ensure" : undefined,
      replace: options.replace || booleanStdin(stdin.replace, "replace", false),
      title: requireText(options.title ?? stdin.title, "--title", 80),
      status: requireText(options.status ?? stdin.status, "--status", 60),
      detail: optionalText(options.detail ?? stdin.detail, "detail", 240),
      progress,
      progressLabel,
      steps: semanticStepsOption(options,stdin),
      symbol: activitySymbol(options.symbol ?? stdin.symbol),
      style: requestedStyle === undefined ? undefined : taskActivityStyle(requestedStyle),
      preset: enumOption(
        options.preset ?? stdin.preset,
        "preset",
        ACTIVITY_PRESENTATION_PRESETS,
      ),
      theme: enumOption(
        options.theme ?? stdin.theme,
        "theme",
        ["system", "light", "dark"],
      ),
      accentColor: accentColor(options["accent-color"] ?? stdin.accentColor),
      expiresInSeconds: parseDuration(options["expires-in"] ?? stdin.expiresInSeconds, {
        defaultSeconds: DEFAULT_ACTIVITY_EXPIRES_SECONDS,
        minimumSeconds: 60,
        maximumSeconds: 28_800,
      }),
      staleAfterSeconds: parseDuration(options["stale-after"] ?? stdin.staleAfterSeconds, {
        defaultSeconds: DEFAULT_ACTIVITY_STALE_SECONDS,
        minimumSeconds: 0,
        maximumSeconds: 28_800,
      }),
      deviceIds: await resolveTargetDevices(
        client,
        options.device.length > 0 ? options.device : stdinDeviceIds(stdin.deviceIds),
      ),
      context: activityContext(options, stdin),
      origin,
      lifecycle,
    });
    return result(
      `activity.${action}`,
      deliveryGuard(
        await client.startActivity(
          body,
          validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey),
        ),
      ),
    );
  }

  if (group === "activity" && action === "status") {
    assertNoExtra(rest,0,"Usage: relo activity status [--name NAME|--origin-file PATH] [--json]");
    assertAllowedOptions(options,["name","origin-file","stdin"]);
    const stdin = await stdinObject(options,dependencies);
    const resolver = await activityResolver(options,stdin);
    const named = activityName(options,stdin);
    if (resolver !== undefined && named !== undefined) {
      throw new UsageError("Use an activity name or a lifecycle resolver, not both");
    }
    return result("activity.status",named === undefined
      ? await client.resolveActivity(resolver ?? { current: true })
      : await client.getActivity(named));
  }

  if (group === "activity" && action === "diagnose") {
    assertAtMostOne(rest,"Usage: relo activity diagnose [ID_OR_NAME|--name NAME] [--wait [--timeout 30s]]");
    assertAllowedOptions(options,["name","wait","timeout"]);
    if (options.timeout !== undefined && !options.wait) {
      throw new UsageError("--timeout requires --wait");
    }
    const named = activityName(options);
    if (rest.length === 1 && named !== undefined) {
      throw new UsageError("Use an activity ID/name or --name, not both");
    }
    const explicitTarget = rest[0] ?? named;
    const selected = explicitTarget === undefined
      ? await client.resolveActivity({ current: true })
      : await client.getActivity(requireText(explicitTarget,"Activity ID or name",128));
    const activity = selected?.activity;
    if (!activity?.id) {
      throw new ApiError("No current Live Activity was found.",{
        status: 404,code: "ACTIVITY_NOT_FOUND",
      });
    }
    const timeoutSeconds = options.wait
      ? parseDuration(options.timeout,{ defaultSeconds: 30,minimumSeconds: 1,maximumSeconds: 300 })
      : 0;
    const startedAt = dependencies.now();
    const deadline = startedAt+timeoutSeconds*1_000;
    let diagnosis = await client.diagnoseActivity(activity.id);
    let polls = 1;
    while (options.wait && !["healthy","failed"].includes(diagnosis?.assessment?.status)
      && dependencies.now() < deadline) {
      await dependencies.sleep(Math.min(2_000,Math.max(0,deadline-dependencies.now())));
      diagnosis = await client.diagnoseActivity(activity.id);
      polls += 1;
    }
    const timedOut = Boolean(options.wait)
      && !["healthy","failed"].includes(diagnosis?.assessment?.status)
      && dependencies.now() >= deadline;
    return result("activity.diagnose",{
      ...diagnosis,
      wait: {
        requested: Boolean(options.wait),
        timeoutSeconds,
        elapsedMs: Math.max(0,dependencies.now()-startedAt),
        polls,
        timedOut,
      },
    },{
      message: `${diagnosis?.assessment?.code ?? "DIAGNOSIS_UNKNOWN"}: ${diagnosis?.assessment?.message ?? "No assessment returned."} ${diagnosis?.assessment?.nextAction ?? ""}`.trim(),
    });
  }

  if (group === "activity" && action === "heartbeat") {
    assertNoExtra(rest,0,"Usage: relo activity heartbeat --stdin [--lease-after 1h] [--json]");
    assertAllowedOptions(options,["lease-after","origin-file","stdin"]);
    const stdin = await stdinObject(options,dependencies);
    const resolver = await activityResolver(options,stdin);
    if (resolver?.lifecycle === undefined) {
      throw new UsageError("Activity heartbeat requires a provider lifecycle identity");
    }
    const resolved = await client.resolveActivity(resolver);
    if (!resolved.found || !resolved.activity) {
      throw new ApiError("No lifecycle exists for this provider run.",{
        status: 404,code: "ACTIVITY_NOT_FOUND",
      });
    }
    const leaseAfterSeconds = parseDuration(
      options["lease-after"] ?? stdin.leaseAfterSeconds,
      { defaultSeconds: 3_600,minimumSeconds: 300,maximumSeconds: 14_400 },
    );
    return result("activity.heartbeat",await client.heartbeatActivity(resolved.activity.id,{
      lifecycle: resolver.lifecycle,leaseAfterSeconds,
    }));
  }

  if (group === "activity" && action === "update") {
    assertAllowedOptions(options, [
      "name",
      "title",
      "status",
      "detail",
      "clear-detail",
      "progress",
      "clear-progress",
      "progress-label",
      "step",
      "step-current",
      "symbol",
      "style",
      "preset",
      "accent-color",
      "stale-after",
      "computer",
      "project",
      "thread-name",
      "task-title",
      "if-sequence",
      "idempotency-key",
      "origin-file",
      "stdin",
    ]);
    const stdin = await stdinObject(options, dependencies);
    const resolver = await activityResolver(options,stdin);
    const named = activityName(options,stdin);
    if (resolver !== undefined && (rest.length > 0 || named !== undefined)) {
      throw new UsageError("Use an activity ID/name or a lifecycle resolver, not both");
    }
    const resolved = resolver === undefined ? undefined : await client.resolveActivity(resolver);
    if (resolved && (!resolved.found || !resolved.activity)) {
      throw new ApiError("No lifecycle exists for this origin.",{ status: 404,code: "ACTIVITY_NOT_FOUND" });
    }
    const target = resolved?.activity?.id
      ?? (rest.length > 0 || named !== undefined
        ? activityTarget(rest,{ name: named },"Usage: relo activity update [ID_OR_NAME|--name NAME] [options]")
        : "current");
    const rawDetail =
      options.detail !== undefined || options["clear-detail"]
        ? detailOption(options)
        : stdin.detail;
    const requestedPreset = enumOption(
      options.preset ?? stdin.preset,
      "preset",
      ACTIVITY_PRESENTATION_PRESETS,
    );
    const requestedUpdateStyle = options.style ?? stdin.style
      ?? (requestedPreset === undefined || requestedPreset === "automatic" ? undefined : requestedPreset);
    const body = definedFields({
      title: optionalText(options.title ?? stdin.title, "title", 80),
      status: optionalText(options.status ?? stdin.status, "status", 60),
      detail: optionalText(rawDetail, "detail", 240),
      progress: progressOption(options, stdin),
      progressLabel: optionalText(
        options["progress-label"] ?? stdin.progressLabel,"progress-label",32,
      ),
      steps: semanticStepsOption(options,stdin),
      symbol: activitySymbol(options.symbol ?? stdin.symbol),
      accentColor: accentColor(options["accent-color"] ?? stdin.accentColor),
      style:
        requestedUpdateStyle === undefined
          ? undefined
          : taskActivityStyle(requestedUpdateStyle, undefined),
      staleAfterSeconds:
        options["stale-after"] === undefined && stdin.staleAfterSeconds === undefined
          ? undefined
          : parseDuration(options["stale-after"] ?? stdin.staleAfterSeconds, {
              minimumSeconds: 0,
              maximumSeconds: 28_800,
            }),
      context: activityContext(options, stdin),
      ifSequence: numberOption(options["if-sequence"] ?? stdin.ifSequence, "if-sequence", {
        minimum: 0,
        integer: true,
      }),
      lifecycle: resolver?.lifecycle,
    });
    if (!Object.entries(body).some(([key, value]) => !["ifSequence","lifecycle"].includes(key) && value !== undefined)) {
      throw new UsageError("Activity update requires at least one changed field");
    }
    return result(
      "activity.update",
      deliveryGuard(
        await client.updateActivity(
          target,
          body,
          validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey),
        ),
      ),
    );
  }

  if (group === "activity" && action === "end") {
    assertAllowedOptions(options, [
      "name",
      "status",
      "detail",
      "clear-detail",
      "progress",
      "clear-progress",
      "symbol",
      "accent-color",
      "dismiss-after",
      "if-sequence",
      "idempotency-key",
      "origin-file",
      "stdin",
    ]);
    const stdin = await stdinObject(options, dependencies);
    const resolver = await activityResolver(options,stdin);
    const named = activityName(options,stdin);
    if (resolver !== undefined && (rest.length > 0 || named !== undefined)) {
      throw new UsageError("Use an activity ID/name or a lifecycle resolver, not both");
    }
    const resolved = resolver === undefined ? undefined : await client.resolveActivity(resolver);
    if (resolved && (!resolved.found || !resolved.activity)) {
      throw new ApiError("No lifecycle exists for this origin.",{ status: 404,code: "ACTIVITY_NOT_FOUND" });
    }
    const target = resolved?.activity?.id
      ?? (rest.length > 0 || named !== undefined
        ? activityTarget(rest,{ name: named },"Usage: relo activity end [ID_OR_NAME|--name NAME] [options]")
        : "current");
    const rawDetail =
      options.detail !== undefined || options["clear-detail"]
        ? detailOption(options)
        : stdin.detail;
    const body = definedFields({
      status: requireText(options.status ?? stdin.status ?? "Complete", "status", 60),
      detail: optionalText(rawDetail, "detail", 240),
      progress: progressOption(options, stdin),
      symbol: activitySymbol(options.symbol ?? stdin.symbol, "success"),
      accentColor: accentColor(options["accent-color"] ?? stdin.accentColor),
      dismissAfterSeconds:
        options["dismiss-after"] !== undefined || stdin.dismissAfterSeconds !== undefined
          ? parseDuration(options["dismiss-after"] ?? stdin.dismissAfterSeconds, {
              minimumSeconds: 0,
              maximumSeconds: 14_400,
            })
          : 300,
      ifSequence: numberOption(options["if-sequence"] ?? stdin.ifSequence, "if-sequence", {
        minimum: 0,
        integer: true,
      }),
      lifecycle: resolver?.lifecycle,
    });
    return result(
      "activity.end",
      deliveryGuard(
        await client.endActivity(
          target,
          body,
          validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey),
        ),
      ),
    );
  }

  if (group === "activity" && action === "get") {
    assertAllowedOptions(options, ["name"]);
    const target = activityTarget(rest, options, "Usage: relo activity get ID_OR_NAME|--name NAME");
    return result(
      "activity.get",
      await client.getActivity(target),
    );
  }

  if (group === "activity" && action === "list") {
    assertNoExtra(rest, 0, "Usage: relo activity list [--limit 1..100]");
    assertAllowedOptions(options, ["limit"]);
    const limit = numberOption(options.limit, "limit", { minimum: 1, maximum: 100, integer: true });
    return result("activity.list", await client.listActivities(limit));
  }

  if (group === "devices" && action === "list") {
    assertNoExtra(rest, 0, "Usage: relo devices list [--page-size 1..100]");
    assertAllowedOptions(options, ["page-size"]);
    const pageSize = numberOption(options["page-size"], "page-size", {
      minimum: 1,
      maximum: 100,
      integer: true,
    });
    return result("devices.list", await listAllDevices(client, pageSize));
  }

  if (group === "services" && action === "create") {
    assertNoExtra(rest, 0, "Usage: relo services create --title TITLE [--secret-file PATH] [options]");
    assertAllowedOptions(options, ["title", "image", "url", "stdin", "secret-file"]);
    const stdin = await stdinObject(options, dependencies);
    const releaseReservation = options["secret-file"] === undefined
      ? undefined
      : await reserveSecretFile(options["secret-file"]);
    let created;
    try {
      created = await client.createService(
        definedFields({
          title: requireText(options.title ?? stdin.title, "Service title", 80),
          imageUrl: validatePublicHttpsUrl(options.image ?? stdin.imageUrl, "image"),
          destinationUrl: validateHttpsUrl(
            options.url ?? stdin.destinationUrl ?? stdin.url,
            "url",
          ),
        }),
      );
      if (options["secret-file"] === undefined) return result("services.create", created);
      try {
        await writeReservedSecretFile(releaseReservation, created?.webhookUrl);
      } catch (error) {
        await revokeCreatedService(client, created);
        throw error;
      }
      const { webhookUrl: _secret, ...safe } = created;
      return result("services.create", {
        ...safe,
        secretFileWritten: true,
        secretFileName: basename(options["secret-file"]),
      });
    } finally {
      if (releaseReservation) await releaseSecretFileReservation(releaseReservation);
    }
  }

  if (group === "services" && action === "list") {
    assertNoExtra(rest, 0, "Usage: relo services list");
    assertAllowedOptions(options, []);
    return result("services.list", await client.listServices());
  }

  throw new UsageError(`Unknown command: ${positionals.join(" ")}`);
}

function createDependencies(overrides = {}) {
  return {
    env: overrides.env ?? process.env,
    configPath: overrides.configPath ?? (() => configPath({ env: overrides.env ?? process.env })),
    loadConfig: overrides.loadConfig ?? loadConfig,
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
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export async function run(argv, io = {}, overrides = {}) {
  if (argv[0] === "permissions" && argv[1] === "hook") {
    if (argv.length !== 3) return runPermissionHook(undefined, io, overrides);
    return runPermissionHook(argv[2], io, overrides);
  }
  if (argv[0] === "permissions" && argv[1] === "opencode-v1-event") {
    if (argv.length !== 2) return EXIT.USAGE;
    try {
      const dependencies = createDependencies(overrides);
      const envelope = await (overrides.readPermissionInput ?? readPermissionInput)();
      await handleOpenCodeV1Event(envelope, {
        fetchImpl: dependencies.fetchImpl,
        ask: (input) => requestPermissionApproval("opencode", input, dependencies),
      });
    } catch {
      // A non-zero exit activates the installed plugin's local reject fallback. A durable
      // reject-pending record remains when the bridge reached its private queue first.
      return EXIT.API;
    }
    return EXIT.OK;
  }
  if (argv[0] === "permissions" && argv[1] === "daemon" && argv[2] === "opencode") {
    if (argv.length !== 3) return EXIT.USAGE;
    const dependencies = createDependencies(overrides);
    await runOpenCodeV2Bridge({
      ...(overrides.openCodeBridgeOptions ?? {}),
      fetchImpl: dependencies.fetchImpl,
      ask: (input) => requestPermissionApproval("opencode", input, dependencies),
    });
    return EXIT.OK;
  }
  const stdout = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const wantsJson = argv.includes("--json");
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
    if (wantsJson) stdout(JSON.stringify(errorEnvelope(error)));
    stderr(`${error.code}: ${error.message}`);
    return error.exitCode;
  }
}

export { EXIT, HELP, VERSION, parseArgs, parseDuration };
