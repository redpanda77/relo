import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { AdapterError,buildChildEnvironment,buildNotification,redactText } from "./adapter.mjs";
import { codexIdentityContext,resolveCodexContext } from "./codex-context.mjs";
import { FileHookStateStore } from "./hook-state.mjs";
import { loadOrCreateInstallationIdentity } from "./installation-identity.mjs";
import { buildCodexLifecycle,parseLifecycleStatus,terminalLifecycleInput } from "./lifecycle.mjs";

const MAX_HOOK_BYTES = 16 * 1024 * 1024;
const WORKING_LEASE_SECONDS = 3_600;
const WAITING_LEASE_SECONDS = 14_400;

function absolute(value,label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new AdapterError(`${label} must be absolute.`);
  return value;
}

export function parseHookArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--relo-bin","--installation-id-path","--state-path"].includes(name)) {
      throw new AdapterError(`Unknown hook option: ${name}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new AdapterError(`${name} requires a value.`);
    result[name.slice(2).replaceAll(/-([a-z])/gu,(_match,letter) => letter.toUpperCase())] = value;
  }
  absolute(result.reloBin,"Relo binary");
  absolute(result.installationIdPath,"Installation identity path");
  if (result.statePath !== undefined) absolute(result.statePath,"Lifecycle state path");
  return result;
}

export async function readHookInput(stream = process.stdin) {
  let raw = "";
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_HOOK_BYTES) throw new AdapterError("Codex hook input is too large.");
    raw += chunk;
  }
  let input;
  try { input = JSON.parse(raw); } catch { throw new AdapterError("Codex hook input is not valid JSON."); }
  if (!input || typeof input !== "object" || Array.isArray(input)
    || typeof input.session_id !== "string" || !input.session_id.trim()
    || typeof input.hook_event_name !== "string") {
    throw new AdapterError("Codex hook input is missing its session identity or event name.");
  }
  return input;
}

function invokeRelo(options,args,input,dependencies) {
  const child = (dependencies.spawnImpl ?? spawnSync)(options.reloBin,args,{
    shell: false,windowsHide: true,encoding: "utf8",stdio: ["pipe","pipe","pipe"],
    input: JSON.stringify(input),timeout: dependencies.timeout ?? 12_000,
    env: buildChildEnvironment(dependencies.environment ?? process.env),
  });
  const exitCode = Number.isInteger(child.status) ? child.status : 3;
  return {
    exitCode,
    stdout: String(child.stdout ?? ""),
    diagnostic: Array.from(redactText(child.stderr || child.error?.message || "")).slice(0,1000).join(""),
  };
}

function activityResult(result,command) {
  if (result.exitCode !== 0) throw new AdapterError(result.diagnostic || `Relo ${command} failed.`,3);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new AdapterError(`Relo ${command} returned invalid JSON.`,3); }
  if (parsed?.ok !== true || parsed.command !== command || typeof parsed.data?.activity?.id !== "string"
    || !Number.isInteger(parsed.data.activity.sequence)) {
    throw new AdapterError(`Relo ${command} returned an invalid activity.`,3);
  }
  return parsed.data.activity;
}

function hookTask(input,sourceInstance,semanticContext = {}) {
  if (typeof input.turn_id !== "string" || !input.turn_id.trim()) {
    throw new AdapterError("Turn-scoped Codex hook input requires turn_id.");
  }
  const completionPayload = {
    type: "agent-turn-complete",
    "thread-id": input.session_id,
    "turn-id": input.turn_id,
    cwd: input.cwd,
    "last-assistant-message": input.last_assistant_message ?? "",
  };
  const notification = buildNotification(completionPayload);
  return {
    notification,
    context: { ...codexIdentityContext(input),...semanticContext },
    ...buildCodexLifecycle(completionPayload,{
      sourceInstance,project: notification.project ?? "Project",
    }),
  };
}

function startInput(task,status = "Planning") {
  return {
    origin: task.origin,lifecycle: task.lifecycle,
    title: `Codex · ${task.notification.project ?? "Project"}`,
    status,
    expiresInSeconds: 28_800,
    staleAfterSeconds: WORKING_LEASE_SECONDS,
    context: taskContext(task),
  };
}

function taskContext(task) {
  const threadName = task.context.threadName ?? task.context.taskTitle ?? "Codex task";
  const taskTitle = task.context.taskTitle ?? "Agent work";
  return {
    ...task.context,
    threadName,
    threadNameSource: task.context.threadNameSource ?? "fallback",
    taskTitle,
    taskTitleSource: task.context.taskTitleSource ?? "fallback",
    computer: task.notification.computer,
    project: task.notification.project ?? "Project",
  };
}

function preservedTaskContext(task,previous = {}) {
  const next = taskContext(task);
  const context = { ...next,...previous };
  for (const field of ["providerName","producerKind","providerThreadId","providerWorkItemId","computer","project"]) {
    if (next[field] !== undefined) context[field] = next[field];
  }
  if (next.threadNameSource !== "fallback" || previous.threadName === undefined) {
    context.threadName = next.threadName;
    context.threadNameSource = next.threadNameSource;
  }
  if (next.taskTitleSource !== "fallback" || previous.taskTitle === undefined) {
    context.taskTitle = next.taskTitle;
    context.taskTitleSource = next.taskTitleSource;
  }
  return context;
}

function includesContext(actual,expected) {
  return actual && Object.entries(expected).every(([key,value]) => actual[key] === value);
}

async function ensureStarted(task,options,state,dependencies) {
  const current = await state.get(task.lifecycle.runId);
  if (current) {
    const statusResult = invokeRelo(options,["activity","status","--stdin","--json"],{
      lifecycle: task.lifecycle,
    },dependencies);
    if (statusResult.exitCode !== 0) {
      throw new AdapterError(statusResult.diagnostic || "Relo lifecycle lookup failed.",3);
    }
    const canonical = parseLifecycleStatus(statusResult.stdout);
    if (canonical.found && canonical.activity.state === "active") {
      const context = preservedTaskContext(task,current.context);
      let activity = canonical.activity;
      if (!includesContext(activity.context,context)) {
        const contextResult = invokeRelo(options,[
          "activity","update","--stdin","--idempotency-key",
          `${task.operationKeys.start}:context:${activity.sequence}`,"--json",
        ],{
          lifecycle: task.lifecycle,status: activity.status ?? "Working",context,
        },dependencies);
        activity = activityResult(contextResult,"activity.update");
      }
      const reconciled = { ...current,activity,context,terminal: false,
        updatedAt: (dependencies.now ?? Date.now)() };
      await state.put(reconciled);
      return reconciled;
    }
  }
  const result = invokeRelo(options,[
    "activity","ensure","--stdin","--idempotency-key",task.operationKeys.start,"--json",
  ],startInput(task),dependencies);
  const activity = activityResult(result,"activity.ensure");
  const context = taskContext(task);
  const entry = {
    origin: task.origin,lifecycle: task.lifecycle,project: task.notification.project ?? "Project",
    context,
    activity,lastMilestone: "planning",updateCount: 0,
    updatedAt: (dependencies.now ?? Date.now)(),terminal: false,
  };
  await state.put(entry);
  return entry;
}

async function updateMilestone(task,options,state,dependencies,milestone) {
  const current = await ensureStarted(task,options,state,dependencies);
  const context = preservedTaskContext(task,current.context);
  const selectedMilestone = milestone === "waiting" ? "waiting" : "working";
  if (current.lastMilestone === selectedMilestone) {
    const heartbeat = invokeRelo(options,["activity","heartbeat","--stdin","--json"],{
      lifecycle: task.lifecycle,
      leaseAfterSeconds: selectedMilestone === "waiting" ? WAITING_LEASE_SECONDS : WORKING_LEASE_SECONDS,
    },dependencies);
    activityResult(heartbeat,"activity.heartbeat");
    await state.put({ ...current,updatedAt: (dependencies.now ?? Date.now)() });
    return { skipped: true,renewed: true };
  }
  const presentation = milestone === "waiting"
    ? { status: "Waiting for approval",symbol: "warning",staleAfterSeconds: WAITING_LEASE_SECONDS }
    : { status: "Working",symbol: "build",staleAfterSeconds: WORKING_LEASE_SECONDS };
  const updateCount = current.updateCount ?? 0;
  const result = invokeRelo(options,[
    "activity","update","--stdin","--idempotency-key",
    `${task.operationKeys[milestone]}:${updateCount+1}`,"--json",
  ],{ lifecycle: task.lifecycle,...presentation,context },dependencies);
  const activity = activityResult(result,"activity.update");
  await state.put({ ...current,context,activity,lastMilestone: selectedMilestone,
    updateCount: updateCount+1,
    updatedAt: (dependencies.now ?? Date.now)() });
  return { skipped: false };
}

async function endTask(task,options,state,dependencies) {
  const statusResult = invokeRelo(options,["activity","status","--stdin","--json"],{
    lifecycle: task.lifecycle,
  },dependencies);
  if (statusResult.exitCode !== 0) throw new AdapterError(statusResult.diagnostic || "Relo lifecycle lookup failed.",3);
  const status = parseLifecycleStatus(statusResult.stdout);
  if (!status.found || status.activity.state !== "active") return { skipped: true };
  const result = invokeRelo(options,[
    "activity","end","--stdin","--idempotency-key",task.operationKeys.end,"--json",
  ],terminalLifecycleInput(task.lifecycle,task.notification),dependencies);
  const activity = activityResult(result,"activity.end");
  const current = await state.get(task.lifecycle.runId);
  if (current) await state.put({ ...current,activity,lastMilestone: "terminal",terminal: true,
    updatedAt: (dependencies.now ?? Date.now)() });
  return { skipped: false };
}

export async function executeHook(options,input,dependencies = {}) {
  const sourceInstance = await (dependencies.loadInstallationIdentity ?? loadOrCreateInstallationIdentity)(
    options.installationIdPath,dependencies.installationIdentityDependencies,
  );
  const state = dependencies.state ?? new FileHookStateStore(
    options.statePath ?? `${options.installationIdPath}.lifecycle-state.json`,{ now: dependencies.now },
  );
  if (input.hook_event_name === "SessionEnd") {
    const sessionTask = buildCodexLifecycle({ "thread-id": input.session_id,"turn-id": "session-end" },{
      sourceInstance,project: "Project",
    });
    const active = await state.activeForThread(sessionTask.origin.thread);
    for (const entry of active) {
      invokeRelo(options,[
        "activity","end","--stdin","--idempotency-key",
        `codex-lifecycle-session-end:${entry.lifecycle.runId.slice(-40)}`,"--json",
      ],{ lifecycle: entry.lifecycle,status: "Stopped",symbol: "warning",dismissAfterSeconds: 30 },{
        ...dependencies,timeout: 2_500,
      });
    }
    return { event: "session-ended" };
  }
  const semanticContext = input.hook_event_name === "UserPromptSubmit"
    ? await (dependencies.resolveCodexContext ?? resolveCodexContext)(input,{
        environment: dependencies.environment ?? process.env,
        ...(dependencies.codexContextDependencies ?? {}),
      })
    : {};
  const task = hookTask(input,sourceInstance,semanticContext);
  if (input.hook_event_name === "UserPromptSubmit") {
    await ensureStarted(task,options,state,dependencies);
    return { event: "turn-started" };
  }
  if (input.hook_event_name === "PostToolUse") {
    return { event: "milestone",...(await updateMilestone(task,options,state,dependencies,"working")) };
  }
  if (input.hook_event_name === "PermissionRequest") {
    return { event: "waiting",...(await updateMilestone(task,options,state,dependencies,"waiting")) };
  }
  if (input.hook_event_name === "Stop") {
    return { event: "turn-completed",...(await endTask(task,options,state,dependencies)) };
  }
  return { event: "ignored" };
}

export async function runHook(argv,io = {},dependencies = {}) {
  const stderr = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const stdout = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  let eventName;
  try {
    const options = parseHookArgs(argv);
    const input = await (dependencies.readInput ?? readHookInput)();
    eventName = input.hook_event_name;
    await executeHook(options,input,dependencies);
    if (eventName === "Stop") stdout("{}");
    return 0;
  } catch (cause) {
    const error = cause instanceof AdapterError ? cause : new AdapterError("Relo Codex lifecycle hook failed.",3);
    stderr(`${error.name}: ${error.message}`);
    if (eventName === "Stop") stdout("{}");
    return error.exitCode;
  }
}
