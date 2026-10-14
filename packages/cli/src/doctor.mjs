import { EXIT, normalizeError } from "./errors.mjs";
import { listAllDevices } from "./commands/admin.mjs";
import { inspectHooks } from "./hooks-settings.mjs";
import { inspectMcp } from "./mcp-config.mjs";
import { pending } from "./outbox/index.mjs";
import { inspectAgentSetup } from "./setup.mjs";
import { inspectSkill, skillAdvice } from "./skill.mjs";
import { updateAdvice } from "./update.mjs";

/** Advice, not failures: the skill never changes `ok` or the exit code. The instruction block is informational only. */
export function setupWarnings(dependencies) {
  const probe = { env: dependencies.env ?? {},home: dependencies.home };
  const setup = inspectAgentSetup({ ...probe,cwd: dependencies.cwd });
  const skill = inspectSkill({ ...probe,cliVersion: dependencies.version });
  const advice = skillAdvice({ ...probe,cliVersion: dependencies.version });
  const state = advice.state;
  return {
    // Setup is the owner's choice: never a step, never a nudge. Shown by `relo doctor --full` only.
    agentSetup: { ok: true,...setup },
    // Hooks too: where they are and which events, never a suggestion to install them.
    hooks: { ok: true,...inspectHooks({ ...probe,cwd: dependencies.cwd }) },
    // And the MCP entry: where it is, never a suggestion to add it.
    mcp: { ok: true,...inspectMcp({ ...probe,cwd: dependencies.cwd,platform: dependencies.platform }) },
    skill: { ok: state === "current",state,...skill,cliVersion: dependencies.version,
      ...(state === "current" ? {} : { hint: advice.hint,run: advice.run }) },
  };
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
  return skill.ok ? { ready: true } : { ready: true,next: { step: "skill",run: skill.run ?? "relo skill status",
    why: `The skill is ${skill.state}: ask the owner before running it; it never blocks work.` } };
}

export async function runDoctor(options,dependencies,helpers) {
  const context = {};
  const outcome = await runChecks(options,dependencies,helpers,context);
  const warnings = setupWarnings(dependencies);
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
  let state = { ready: false };
  if (context.loginWhy) {
    state = { ready: false,next: await loginStep(dependencies,context.loginWhy,context.hasConfig) };
  } else if (outcome.data.ok) {
    state = await readiness(dependencies,context.client,context.config,warnings);
  }
  return { ...outcome,data: { ...outcome.data,ready: state.ready,...(state.next ? { next: state.next } : {}),warnings } };
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
