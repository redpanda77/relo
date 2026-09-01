import { createHash } from "node:crypto";
import { AdapterError } from "./adapter.mjs";

function digest(label,value) {
  return createHash("sha256").update(`${label}\u0000${value}`).digest("hex").slice(0,40);
}

function boundedIdentity(value,label) {
  if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > 200) {
    throw new AdapterError(`${label} must be a bounded non-empty identity.`);
  }
  return value.trim();
}

export function buildAgentLifecycle({
  provider,sourceInstance,project = "Project",sessionId,providerRunId,
}) {
  if (typeof provider !== "string" || !/^[a-z0-9][a-z0-9._-]{0,39}$/u.test(provider)) {
    throw new AdapterError("A valid lifecycle provider is required.");
  }
  const installation = boundedIdentity(sourceInstance,"Persistent installation identity");
  if (Array.from(installation).length > 160) {
    throw new AdapterError("Persistent installation identity is too long.");
  }
  const session = boundedIdentity(sessionId,"Provider session identity");
  const providerRun = boundedIdentity(providerRunId,"Provider run identity");
  const thread = `${provider}-task-${digest(`relo:${provider}-thread:v1`,`${installation}\u0000${session}`)}`;
  const runId = `${provider}-run-${digest(`relo:${provider}-turn:v1`,`${thread}\u0000${providerRun}`)}`;
  const operations = ["start","planning","working","verifying","waiting","finishing","end","session-end"];
  return {
    origin: { sourceInstance: installation,project,thread,channel: "task-progress" },
    lifecycle: { provider,runId },
    operationKeys: Object.fromEntries(operations.map((operation) => [
      operation,
      `${provider}-lifecycle-${operation}:${digest(`relo:${provider}-operation:${operation}:v1`,runId)}`,
    ])),
    completionIdempotencyKey: `${provider}-lifecycle-end:${digest(`relo:${provider}-operation:end:v1`,runId)}`,
  };
}

export function buildCodexLifecycle(payload,{ sourceInstance,project = "Project" } = {}) {
  if (typeof sourceInstance !== "string" || !/^codex-notify-[a-f0-9]{32}$/u.test(sourceInstance)) {
    throw new AdapterError("A valid persistent installation identity is required.");
  }
  const threadId = payload?.["thread-id"];
  const turnId = payload?.["turn-id"];
  if (typeof threadId !== "string" || !threadId.trim() || Array.from(threadId.trim()).length > 200) {
    throw new AdapterError("Codex completion payload requires a bounded thread-id.");
  }
  if (typeof turnId !== "string" || !turnId.trim() || Array.from(turnId.trim()).length > 200) {
    throw new AdapterError("Codex completion payload requires a bounded turn-id.");
  }
  return buildAgentLifecycle({
    provider: "codex",sourceInstance,project,sessionId: threadId,providerRunId: turnId,
  });
}

export function parseLifecycleStatus(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new AdapterError("Relo returned invalid lifecycle status JSON.",3);
  }
  if (envelope?.ok !== true || envelope.command !== "activity.status"
    || typeof envelope.data?.found !== "boolean") {
    throw new AdapterError("Relo returned an invalid lifecycle status result.",3);
  }
  if (!envelope.data.found) return { found: false,activity: null };
  const activity = envelope.data.activity;
  if (!activity || typeof activity.id !== "string" || !Number.isInteger(activity.generation)
    || !Number.isInteger(activity.sequence) || typeof activity.state !== "string") {
    throw new AdapterError("Relo returned an invalid lifecycle activity.",3);
  }
  return { found: true,activity };
}

export function terminalLifecycleInput(lifecycle,notification) {
  const needsAttention = notification.body.startsWith("Needs attention");
  return {
    lifecycle,
    status: needsAttention ? "Needs attention" : "Complete",
    symbol: needsAttention ? "warning" : "success",
    dismissAfterSeconds: needsAttention ? 300 : 30,
  };
}
