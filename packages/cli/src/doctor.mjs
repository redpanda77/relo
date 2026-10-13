import { EXIT, normalizeError } from "./errors.mjs";

export async function runDoctor(options,dependencies,{ isReadyResponse,safeCredential }) {
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
    return {
      exitCode: EXIT.AUTH,command: "doctor",data: { ok: false,checks },
      message: "Relo is not logged in on this host. Run `relo auth login`.",
    };
  }
  const client = dependencies.clientFactory(config);
  try {
    const ready = await client.ready();
    checks.server = {
      ok: isReadyResponse(ready),state: isReadyResponse(ready) ? "reachable" : "not_ready",
      apiUrl: config.apiUrl,
    };
  } catch (error) {
    const normalized = normalizeError(error);
    checks.server = { ok: false,state: normalized.code,apiUrl: config.apiUrl };
    return {
      exitCode: normalized.exitCode === EXIT.NETWORK ? EXIT.NETWORK : EXIT.API,
      command: "doctor",data: { ok: false,checks },message: "Relo server is unreachable or not ready.",
    };
  }
  try {
    const status = await client.authStatus();
    if (status?.authenticated !== true) {
      checks.auth = { ok: false,state: "rejected" };
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
  } catch (error) {
    checks.auth = { ok: false,state: normalizeError(error).code };
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
      ? "Relo is ready."
      : activityEvidenceMissing
        ? "Relo activity credentials need `devices:read` for delivery evidence. Run `relo auth login`."
        : "Relo needs attention; inspect the failed doctor stages.",
  };
}
