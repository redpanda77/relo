import { isAbsolute, join } from "node:path";

function parseSingleEnvelope(result) {
  if (!result || !Number.isInteger(result.exitCode) || typeof result.stdout !== "string") return undefined;
  const lines = result.stdout.trimEnd().split("\n");
  if (lines.length !== 1) return undefined;
  try {
    const envelope = JSON.parse(lines[0]);
    return envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope : undefined;
  } catch {
    return undefined;
  }
}

const EXPLICIT_NON_TRIGGER = /^(?:explain|compare|review|build a generic|add a local|write unit tests|design .* only|do not|summarize|create a calendar|describe)\b|\bwithout contacting\b|\bbut do not\b|\bfrom the pasted text only\b/iu;
const EXPLICIT_RELO_INTENT = /\brelo\b|\brelo\b|\biphone\b|\bmy phone\b|\bdynamic island\b|\blive activit(?:y|ies)\b|\bcodex completion\b/iu;

// This deterministic classifier validates only the curated explicit-intent fixtures. It is not a
// substitute for evaluating whether a model selects the installed skill for novel wording.
export function classifyExplicitTrigger(prompt) {
  return !EXPLICIT_NON_TRIGGER.test(prompt) && EXPLICIT_RELO_INTENT.test(prompt);
}

export async function runOrdinarySendWorkflow(invoke, {
  body = "Reviewed work is ready",
  title = "Codex",
  idempotencyKey = "skill-eval:ordinary:send",
} = {}) {
  const result = await invoke([
    "notify", "send", body, "--title", title,
    "--idempotency-key", idempotencyKey, "--json",
  ]);
  const envelope = parseSingleEnvelope(result);
  return {
    accepted: result?.exitCode === 0
      && envelope?.ok === true
      && envelope?.data?.delivery?.durableCommands > 0,
    command: envelope?.command,
  };
}

export async function runBrowserAuthWorkflow(invoke, {
  apiUrl = "https://relo.example.test",
  clientName = "Workstation agent",
} = {}) {
  const result = await invoke([
    "auth", "login", "--api-url", apiUrl, "--client-name", clientName,
    "--scope", "notifications:send", "--scope", "interactions:create",
    "--scope", "interactions:read",
    "--no-open", "--json",
  ]);
  const envelope = parseSingleEnvelope(result);
  const serialized = JSON.stringify(envelope);
  return {
    authenticated: result?.exitCode === 0
      && envelope?.ok === true
      && envelope?.data?.authenticated === true
      && envelope?.data?.apiUrl === apiUrl,
    credentialExposed: /(?:accessToken|deviceCode|authorization)/u.test(serialized),
  };
}

export async function runNotifierMaintenanceWorkflow(runTool, {
  cliArtifact,
  notifierArtifact,
  adapter,
  relo,
  config,
  npmPrefix,
  nodePath = process.execPath,
} = {}) {
  const prefixArgs = npmPrefix === undefined ? [] : ["--prefix", npmPrefix];
  const operations = [];
  const results = [];
  const execute = async (command, args) => {
    operations.push([command, args]);
    const result = await runTool(command, args);
    results.push(result);
    return result;
  };
  const evidence = () => ({
    installExitCode: results[0]?.exitCode,
    rootExitCode: results[1]?.exitCode,
    dryRunExitCode: results[2]?.exitCode,
    configureExitCode: results[3]?.exitCode,
  });
  const installed = await execute("npm", [
    "install", "--global", "--ignore-scripts", ...prefixArgs, cliArtifact, notifierArtifact,
  ]);
  if (installed?.exitCode !== 0) {
    return { completed: false, failedAt: "install", operations, evidence: evidence() };
  }

  const rootResult = await execute("npm", ["root", "--global", ...prefixArgs]);
  const rootLines = typeof rootResult?.stdout === "string"
    ? rootResult.stdout.trimEnd().split("\n")
    : [];
  const installedRoot = rootLines.length === 1 ? rootLines[0] : undefined;
  if (rootResult?.exitCode !== 0 || !installedRoot || !isAbsolute(installedRoot)) {
    return { completed: false, failedAt: "package-root", operations, evidence: evidence() };
  }
  const configureScript = join(
    installedRoot,
    "@relo",
    "codex-notify",
    "scripts",
    "configure-codex-notify.mjs",
  );

  const dryRun = await execute(adapter, ["--dry-run", JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "skill-maintenance-thread",
    "turn-id": "skill-maintenance-turn",
  })]);
  if (dryRun?.exitCode !== 0) {
    return {
      completed: false,
      failedAt: "adapter-dry-run",
      operations,
      evidence: evidence(),
      configureScript,
    };
  }
  await execute(nodePath, [configureScript, "--config", config, "--adapter", adapter,
    "--relo", relo, "--backup-suffix", "skill-maintenance"]);
  return {
    completed: results.every((result) => result?.exitCode === 0),
    operations,
    evidence: evidence(),
    configureScript,
  };
}

export function evaluateErrorFixture(fixture) {
  const decisions = {
    no_durable_delivery: "stop-no-delivery",
    affirmative_text_permission: "deny-permission",
    malformed_success_envelope: "deny-permission",
    pasted_token_workaround: "reject-credential",
    unsafe_phone_content: "refuse-transmission",
  };
  return decisions[fixture];
}

export async function runPermissionWorkflow(invoke, prompt = "Approve the reviewed action?") {
  const createdResult = await invoke([
    "notify", "ask", prompt, "--approval", "--wait", "--timeout", "15m",
    "--idempotency-key", "skill-eval:permission:create", "--json",
  ]);
  const created = parseSingleEnvelope(createdResult);
  const interaction = created?.data?.interaction ?? created?.data;
  if (
    createdResult?.exitCode !== 0 || created?.ok !== true
    || !interaction?.id || created?.data?.delivery?.durableCommands <= 0
  ) return { allowed: false, reason: "create-gate" };

  const fetchedResult = await invoke(["interaction", "get", interaction.id, "--json"]);
  const fetched = parseSingleEnvelope(fetchedResult);
  const canonical = fetched?.data?.interaction ?? fetched?.data;
  const allowed = fetchedResult?.exitCode === 0
    && fetched?.ok === true
    && canonical?.id === interaction.id
    && canonical?.type === "approval"
    && canonical?.state === "approved"
    && canonical?.action === "approve"
    && typeof canonical?.respondingDevice?.id === "string"
    && canonical.respondingDevice.id.length > 0
    && typeof canonical?.respondedAt === "string"
    && canonical.respondedAt.length > 0;
  return { allowed, reason: allowed ? "approved" : "canonical-gate", interactionId: interaction.id };
}

export function chooseActivityStyle({ longRunning, quantitative, stages, terminalLike, prominent }) {
  if (!longRunning) return undefined;
  if (quantitative) return "standard";
  if (Array.isArray(stages) && stages.length > 1) return "steps";
  if (terminalLike) return "terminal";
  if (prominent) return "hero";
  return "standard";
}

export async function runActivityWorkflow(invoke, { style, milestones }) {
  const start = await invoke([
    "activity", "ensure", "--title", "Build validation",
    "--status", "Starting", "--style", style, "--idempotency-key", "skill-eval:activity:start", "--json",
  ]);
  const startEnvelope = parseSingleEnvelope(start);
  const activity = startEnvelope?.data?.activity ?? startEnvelope?.data;
  if (start.exitCode !== 0 || !activity?.id || !Number.isInteger(activity.sequence)) {
    return { completed: false };
  }
  for (let index = 0; index < milestones.length; index += 1) {
    const updated = await invoke([
      "activity", "update", "--status", milestones[index],
      "--idempotency-key", `skill-eval:activity:update:${index}`, "--json",
    ]);
    const envelope = parseSingleEnvelope(updated);
    const next = envelope?.data?.activity ?? envelope?.data;
    if (updated.exitCode !== 0 || next?.id !== activity.id || !Number.isInteger(next.sequence)) {
      return { completed: false, activityId: activity.id };
    }
  }
  const waiting = await invoke([
    "activity", "wait", activity.id, "Approve the reviewed continuation?", "--approval",
    "--wait", "--timeout", "15m",
    "--idempotency-key", "skill-eval:activity:wait:approval", "--json",
  ]);
  const waitEnvelope = parseSingleEnvelope(waiting);
  const waitData = waitEnvelope?.data;
  const interaction = waitData?.interaction;
  if (waiting.exitCode !== 0 || waitEnvelope?.ok !== true
    || waitData?.parentActivityId !== activity.id
    || waitData?.delivery?.durableCommands <= 0
    || typeof interaction?.id !== "string"
    || interaction.type !== "approval"
    || interaction.state !== "approved"
    || interaction.action !== "approve"
    || typeof interaction.respondingDevice?.id !== "string"
    || interaction.respondingDevice.id.length === 0
    || typeof interaction.respondedAt !== "string"
    || interaction.respondedAt.length === 0) {
    return { completed: false, activityId: activity.id, waited: false };
  }
  const ended = await invoke([
    "activity", "end", "--status", "Complete",
    "--idempotency-key", "skill-eval:activity:end", "--json",
  ]);
  const endEnvelope = parseSingleEnvelope(ended);
  const terminal = endEnvelope?.data?.activity ?? endEnvelope?.data;
  return {
    completed: ended.exitCode === 0 && terminal?.id === activity.id,
    activityId: activity.id,
    waited: true,
    interactionId: interaction.id,
  };
}

export async function runServiceCreationWorkflow(invoke, { title, secretFile }) {
  const result = await invoke([
    "services", "create", "--title", title, "--secret-file", secretFile, "--json",
  ]);
  const envelope = parseSingleEnvelope(result);
  if (result?.exitCode !== 0 || envelope?.ok !== true) return { created: false };
  const serialized = JSON.stringify(envelope);
  return {
    created: envelope.data?.secretFileWritten === true
      && typeof envelope.data?.service?.id === "string"
      && !serialized.includes("webhookUrl"),
    serviceId: envelope.data?.service?.id,
  };
}

export async function runPinnedInstall(
  runInstaller,
  { global = false, source = "./skills/relo-notifications" } = {},
) {
  const args = [
    "--yes", "skills@1.5.22", "add", source, "--skill", "relo-notifications",
    "--agent", "codex", "--yes", "--copy",
    ...(global ? ["--global"] : []),
  ];
  return runInstaller("npx", args);
}

export async function runToolingLifecycle(runTool, artifacts) {
  const verify = (manifest, cli, notifier) => runTool(artifacts.nodePath ?? process.execPath, [
    artifacts.identityHelper, "verify",
    "--manifest", manifest,
    "--cli", cli,
    "--notifier", notifier,
  ]);
  const install = (cli, notifier) => runTool("npm", [
    "install", "--global", cli, notifier,
  ]);
  await verify(artifacts.oldManifest, artifacts.oldCli, artifacts.oldNotifier);
  await install(artifacts.oldCli, artifacts.oldNotifier);
  await verify(artifacts.newManifest, artifacts.newCli, artifacts.newNotifier);
  await install(artifacts.newCli, artifacts.newNotifier);
  await verify(artifacts.oldManifest, artifacts.oldCli, artifacts.oldNotifier);
  await install(artifacts.oldCli, artifacts.oldNotifier);
  await runTool("npm", [
    "uninstall", "--global", "@relo/codex-notify", "@relo/cli",
  ]);
}
