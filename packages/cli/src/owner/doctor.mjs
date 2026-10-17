import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXIT, UsageError, normalizeError } from "../shared/errors.mjs";
import { listAllDevices } from "../shared/devices.mjs";
import { readHarnessCredential } from "../harness/core/credential.mjs";
import { inspectBlocks, inspectHooksInstall, inspectMcpInstall, inspectPath } from "../install/inspect.mjs";
import { pending } from "../outbox/index.mjs";
import { inspectSkill, skillAdvice } from "../install/skill.mjs";
import { updateAdvice } from "./releases.mjs";
import { FACTS } from "../shared/facts.mjs";
import { harnessesOf } from "./machine-report.mjs";
import { harnessLabel } from "../harness/catalog.mjs";
import { adapterFor } from "../harness/adapters/index.mjs";
import { surfaceFor } from "../caller.mjs";
import { sessionKey } from "../shared/session-key.mjs";
import { isReadyResponse, safeCredential } from "./credential-shape.mjs";

/**
 * Advice, not failures: nothing here changes `ok` or the exit code. What relo setup wrote, checked against
 * this CLI (install/inspect.mjs), and the skill. Doctor never suggests adding hooks or an MCP entry.
 */
export async function setupWarnings(dependencies) {
  const probe = { env: dependencies.env ?? {}, home: dependencies.home, cwd: dependencies.cwd, platform: dependencies.platform };
  const credential = await readHarnessCredential(dependencies).catch(() => undefined);
  const hooks = inspectHooksInstall(probe, { credential });
  const mcp = inspectMcpInstall(probe, { nodePath: dependencies.nodePath, entrypoint: dependencies.entrypoint });
  // Only hooks and shell MCP entries run `relo` by name, so only then does PATH matter.
  const runsRelo = hooks.state !== "none" || (mcp.files ?? []).some((file) => file.runs === "relo");
  const skill = inspectSkill({ ...probe, cliVersion: dependencies.version });
  const found = skillAdvice({ ...probe, cliVersion: dependencies.version });
  // The notify level leaves the skill out by design: a missing skill there is not a problem to fix.
  const advice = found.state === "missing" && notifyOnly(dependencies, probe) ? { state: "not_needed" } : found;
  return {
    agentSetup: inspectBlocks(probe),
    ...agentsNotSetUp(dependencies, probe),
    ...await sessionNamesDiffer(dependencies),
    hooks,
    mcp,
    ...(runsRelo && dependencies.entrypoint ? { path: inspectPath({ env: dependencies.env ?? {}, entrypoint: dependencies.entrypoint }) } : {}),
    skill: { ok: advice.state === "current" || advice.state === "not_needed", state: advice.state, ...skill, cliVersion: dependencies.version,
      ...(advice.hint ? { hint: advice.hint, run: advice.run } : {}) },
  };
}

/** Every agent Relo set up here is at the notify level (instructions only, no skill). */
function notifyOnly(dependencies, probe) {
  const rows = (() => { try { return harnessesOf(dependencies, probe); } catch { return []; } })();
  const setUp = rows.filter((row) => row.id !== "agents" && row.level !== "none");
  return setUp.length > 0 && setUp.every((row) => row.level === "notify");
}

/**
 * Agents this computer has that Relo does not cover yet (installed after `relo setup`), the same rule the Dashboard's
 * Set up checklist reads from the machine report. Only once some agent is set up: before that, the skill advice says so.
 */
function agentsNotSetUp(dependencies, probe) {
  const rows = (() => { try { return harnessesOf(dependencies, probe); } catch { return []; } })();
  if (!rows.some((row) => row.level !== "none")) return {};
  const waiting = rows.filter((row) => row.id !== "agents" && row.detected && row.level === "none").map((row) => row.id);
  if (waiting.length === 0) return {};
  const names = waiting.map(harnessLabel).join(", ");
  return { agentsNotSetUp: { ok: false, state: names, agents: waiting,
    hint: `Relo does not cover ${names} here yet: relo setup ${waiting.map((id) => `--agent ${id}`).join(" ")}`,
    run: `relo setup ${waiting.map((id) => `--agent ${id}`).join(" ")}` } };
}

const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const OBSERVED_MAX = 500;

/** Observed Claude Code sessions on this computer that are not ended and were seen in the last 24 h: Set of session keys. */
function liveSessionKeys(dependencies) {
  const directory = dependencies.observedStateDirectory;
  const keys = new Set();
  if (!directory) return keys;
  const now = (dependencies.now ?? Date.now)();
  let names = [];
  try { names = readdirSync(directory).filter((name) => name.endsWith(".json") && !name.startsWith(".")).slice(0, OBSERVED_MAX); } catch { return keys; }
  for (const name of names) {
    try {
      const path = join(directory, name);
      if (statSync(path).size > 64 * 1024) continue;
      const state = JSON.parse(readFileSync(path, "utf8"));
      const seen = Date.parse(state?.lastSeenAt);
      if (state?.v === 1 && state.harness === "claude-code" && state.phase !== "ended" && typeof state.session === "string"
        && Number.isFinite(seen) && now - seen >= 0 && now - seen <= LIVE_WINDOW_MS) keys.add(state.session);
    } catch { /* an unreadable file is skipped */ }
  }
  return keys;
}

/**
 * Sessions whose Relo name differs from the title the Claude desktop app shows in its sidebar. Advice only. The
 * names appear in the local output (`sessions`, under --full) and nowhere else: this is never sent to a server.
 */
export async function sessionNamesDiffer(dependencies) {
  // Session isolation: another session's names are the owner's to see, never an agent's.
  if (surfaceFor(dependencies.caller) === "agent") return {};
  try {
    const adapter = adapterFor("claude-code");
    const live = liveSessionKeys(dependencies);
    if (live.size === 0 || typeof adapter?.sidebarSessions !== "function") return {};
    const differing = [];
    for (const [id, desktop] of await adapter.sidebarSessions({ home: dependencies.home })) {
      if (!live.has(sessionKey({ harness: "claude-code", id }))) continue;
      const relo = adapter.sessionTitle({ session_id: id, cwd: desktop.cwd ?? dependencies.cwd }, { env: dependencies.env, home: dependencies.home });
      if (relo && relo !== desktop.title) differing.push({ relo, sidebar: desktop.title });
    }
    if (differing.length === 0) return {};
    const count = differing.length;
    return { sessionNamesDiffer: { ok: false, state: `${count} session${count === 1 ? "" : "s"} named differently from the Claude Desktop sidebar`,
      count, sessions: differing.slice(0, 20),
      hint: "The card name will follow the sidebar once the name fix ships; until then, rename the session in Claude Desktop to match." } };
  } catch {
    return {};
  }
}

const LOGIN_RUN = "relo auth login --no-wait";

async function loginStep(dependencies,why,hasConfig) {
  let pending = null;
  try { pending = await dependencies.pendingLogin?.read(); } catch { pending = null; }
  if (pending && dependencies.now() < pending.expiresAtMs) {
    return { step: "login",run: "relo auth login --wait",why: "A sign-in link is waiting for the owner to approve it." };
  }
  return { step: "login",run: hasConfig ? LOGIN_RUN : `${LOGIN_RUN} --api-url https://YOUR-RELO-SERVER`,why };
}

/** The first unmet onboarding step, in order: sign-in, a phone, the first test, then (warning only) the skill. */
async function readiness(dependencies,client,config,warnings) {
  let devices;
  try { devices = (await listAllDevices(client)).devices; } catch { return { ready: false }; }
  if (!devices.some((device) => device.liveActivityAuthorization === "authorized")) {
    return { ready: false,next: { step: "phone",run: "relo devices list",
      why: devices.length === 0
        ? "No iPhone is signed in: the owner opens the Relo app, signs in and allows Live Activities."
        : "No iPhone has Live Activities on: the owner enables them in iOS Settings > Relo." } };
  }
  // Environment credentials have no config file to remember a test in, so the step cannot apply.
  // One confirmed test is enough: a phone that re-registers gets a new device ID, and asking the
  // owner again for that would be noise. `relo test --again` re-runs it on purpose.
  const tested = config.source === "environment" || Boolean(config.phoneTest);
  if (!tested) {
    return { ready: false,next: { step: "test",run: "relo test",
      why: "Confirm once that the owner's iPhone shows a Relo card." } };
  }
  const skill = warnings.skill;
  return skill.ok ? { ready: true } : { ready: true,next: { step: "skill",run: skill.run ?? "relo setup",
    why: `The skill is ${skill.state}: ask the owner before running it; it never blocks work.` } };
}

/** The account's privacy promise in one line: whether content must be sealed and how long the server keeps it. */
function privacyLine(content) {
  const encryption = content.encryptionRequired ? "end-to-end encryption required" : "end-to-end encryption not required";
  const kept = !content.retentionKnown ? "retention unknown (the worker has not reported)"
    : content.retentionHours ? `ended content deleted after ${content.retentionHours} hours` : "content kept until deleted (no retention window set)";
  return `${encryption}; ${kept}`;
}

/** `relo doctor [--smoke] [--full]`. */
export async function runDoctorCommand({ action, options, dependencies }) {
  if (action !== undefined) throw new UsageError("Usage: relo doctor [--smoke] [--full]");
  return runDoctor(options, dependencies, { isReadyResponse, safeCredential });
}

/**
 * The doctor's checks without its output (`relo auth join`): runs them, records the result for the machine report
 * the way a doctor run does, and returns the failing checks as { name, state } rows (empty when all passed).
 */
export async function quietSelfCheck(dependencies) {
  const outcome = await runChecks({}, dependencies, { isReadyResponse, safeCredential }, {});
  await dependencies.recordDoctor?.(outcome.data.checks);
  const failing = Object.entries(outcome.data.checks).filter(([, check]) => check?.ok === false && check?.state !== "skipped")
    .map(([name, check]) => ({ name, state: String(check.state ?? "failed") }));
  return { ok: failing.length === 0, failing };
}

async function runDoctor(options,dependencies,helpers) {
  const context = {};
  const outcome = await runChecks(options,dependencies,helpers,context);
  await dependencies.recordDoctor?.(outcome.data.checks);
  const warnings = await setupWarnings(dependencies);
  // Read-only except one cache file (update-check.json, 24 h). Only asked when the server answered, so offline costs nothing.
  if (outcome.data.checks.server.ok) {
    const update = await updateAdvice(dependencies).catch(() => undefined);
    if (update) warnings.update = update;
  }
  // Anything still queued locally (offline writes, observed snapshots) or dropped by the server: shown
  // only when there is something, never a failure (the flusher retries on its own).
  const queued = dependencies.outboxDirectory ? await pending({ directory: dependencies.outboxDirectory }).catch(() => undefined) : undefined;
  if (queued && (queued.total > 0 || queued.dead.length > 0)) {
    warnings.outbox = { ok: true,pending: queued.total,...(queued.oldestAt ? { oldestAt: queued.oldestAt } : {}),dead: queued.dead.length,run: "relo outbox status" };
  }
  // Credentials nobody used for a month (plan 10 B2): advice to revoke, never a failure.
  if (context.unusedCredentials?.length) {
    warnings.unusedCredentials = { ok: false,state: `${context.unusedCredentials.length} unused for ${FACTS.credentials.unusedDays}+ days`,
      hint: context.unusedCredentials.slice(0,3).map((item) => `${item.kind} "${item.name}"`).join(", ")
        + ": revoke what you no longer use (relo services revoke, or Connections → Computers in the Dashboard)" };
  }
  let state = { ready: false };
  if (context.loginWhy) {
    state = { ready: false,next: await loginStep(dependencies,context.loginWhy,context.hasConfig) };
  } else if (outcome.data.ok) {
    state = await readiness(dependencies,context.client,context.config,warnings);
  }
  const privacy = context.content ? privacyLine(context.content) : undefined;
  // After the checks and the release look-up, so the report carries this run and the fresh cache.
  await dependencies.sendMachineReport?.();
  return { ...outcome,data: { ...outcome.data,ready: state.ready,...(state.next ? { next: state.next } : {}),...(privacy ? { privacy } : {}),warnings } };
}

async function runChecks(options,dependencies,{ isReadyResponse,safeCredential },context) {
  const checks = {
    localConfig: { ok: false,state: "missing" },
    server: { ok: false,state: "skipped" },
    auth: { ok: false,state: "skipped" },
    runtime: { ok: false,state: "skipped" },
  };
  let config;
  try {
    config = await dependencies.loadConfig(dependencies.configPath());
    checks.localConfig = { ok: true,state: config.source === "environment" ? "environment" : "secure" };
  } catch (error) {
    checks.localConfig = { ok: false,state: normalizeError(error).code };
    context.loginWhy = "Relo is not signed in on this computer.";
    return {
      exitCode: EXIT.AUTH,command: "doctor",data: { ok: false,checks },
      message: "Relo is not logged in on this host. Run `relo auth login`.",
    };
  }
  context.hasConfig = true;
  const client = dependencies.clientFactory(config);
  context.client = client;
  context.config = config;
  try {
    const ready = await client.ready();
    checks.server = {
      ok: isReadyResponse(ready),state: isReadyResponse(ready) ? "reachable" : "not_ready",
      apiUrl: config.apiUrl,
    };
  } catch (error) {
    const normalized = normalizeError(error);
    checks.server = { ok: false,state: normalized.code,apiUrl: config.apiUrl };
    context.loginWhy = "The Relo server did not answer: check the network and the server address, then sign in again if it moved.";
    return {
      exitCode: normalized.exitCode === EXIT.NETWORK ? EXIT.NETWORK : EXIT.API,
      command: "doctor",data: { ok: false,checks },message: "Relo server is unreachable or not ready.",
    };
  }
  try {
    const status = await client.authStatus();
    if (status?.authenticated !== true) {
      checks.auth = { ok: false,state: "rejected" };
      context.loginWhy = "The server no longer accepts this sign-in.";
      return {
        exitCode: EXIT.AUTH,command: "doctor",data: { ok: false,checks },
        message: "Relo credentials need attention. Run `relo auth login`.",
      };
    }
    const credential = safeCredential(status.credential);
    const scopes = new Set(credential.scopes);
    const activityEvidenceMissing = (scopes.has("activities:read") || scopes.has("activities:write"))
      && !scopes.has("devices:read");
    checks.auth = activityEvidenceMissing
      ? {
          ok: false,state: "activity_evidence_scope_missing",credential,
          missingScopes: ["devices:read"],
        }
      : { ok: true,state: "authenticated",credential };
    if (activityEvidenceMissing) context.loginWhy = "This sign-in lacks devices:read; sign in again to get every permission.";
  } catch (error) {
    checks.auth = { ok: false,state: normalizeError(error).code };
    context.loginWhy = "The server did not accept this sign-in.";
    return {
      exitCode: EXIT.AUTH,command: "doctor",data: { ok: false,checks },
      message: "Relo credentials need attention. Run `relo auth login`.",
    };
  }
  try {
    const runtime = await client.doctor();
    checks.runtime = {
      ok: runtime?.version === 1 && runtime?.ok === true,
      state: runtime?.version === 1 ? "checked" : "invalid_response",
      releaseIdentity: runtime?.releaseIdentity ?? null,
      checks: runtime?.checks ?? null,
    };
    context.content = runtime?.content;
    context.unusedCredentials = Array.isArray(runtime?.unusedCredentials) ? runtime.unusedCredentials : [];
  } catch (error) {
    checks.runtime = { ok: false,state: normalizeError(error).code };
  }
  if (options.smoke) {
    try {
      const response = await client.sendNotification({
        title: "Relo doctor smoke test",
        body: "Server accepted the doctor smoke notification.",
        sourceName: "Relo doctor",
        context: { providerName: "Relo doctor",project: "Relo operations",
          threadName: "Readiness checks",providerThreadId: "relo-doctor:readiness" },
      },dependencies.generateIdempotencyKey());
      const durableCommands = Number(response?.delivery?.durableCommands ?? response?.durableCommands ?? 0);
      checks.smoke = {
        ok: typeof response?.eventId === "string" && durableCommands > 0,
        serverAccepted: typeof response?.eventId === "string",
        durableCommands,
        providerAccepted: null,
        phoneReceived: null,
        note: "Provider acceptance and phone receipt require later delivery evidence; this command does not infer either.",
      };
    } catch (error) {
      checks.smoke = {
        ok: false,serverAccepted: false,providerAccepted: null,phoneReceived: null,
        error: normalizeError(error).code,
      };
    }
  }
  const ok = Object.values(checks).every((check) => check.ok);
  const activityEvidenceMissing = checks.auth.state === "activity_evidence_scope_missing";
  return {
    exitCode: ok ? EXIT.OK : activityEvidenceMissing ? EXIT.AUTH : EXIT.API,
    command: "doctor",data: { ok,checks },
    message: ok
      ? (options.full ? "Relo is ready." : undefined)
      : activityEvidenceMissing
        ? "Relo activity credentials need `devices:read` for delivery evidence. Run `relo auth login`."
        : "Relo needs attention; inspect the failed doctor stages.",
  };
}
