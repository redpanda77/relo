import { spawn } from "node:child_process";
import { platform } from "node:os";
import { parseDuration, requireText } from "../args.mjs";
import { normalizeApiUrl } from "../config.mjs";
import { ApiError, AuthError, EXIT, NetworkError, ReloError, UsageError, normalizeError } from "../errors.mjs";
import { inAgentContext } from "../identity.mjs";
import { assertAllowedOptions, assertNoExtra, getAuthenticated, result } from "../support.mjs";

export const DEFAULT_LOGIN_SCOPES = [
  "notifications:send",
  "interactions:create",
  "interactions:read",
  "activities:write",
  "activities:read",
  "devices:read",
  "services:read",
  "services:write",
  "sessions:write",
];

export const ALLOWED_LOGIN_SCOPES = new Set([
  ...DEFAULT_LOGIN_SCOPES,
]);

export function openBrowser(url) {
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

export function authFlowError(message, code, exitCode, details) {
  return new ReloError(message, { code, exitCode, details });
}

export function safeCredential(value) {
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

export function validateAuthorizationStart(value, apiUrl) {
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

export function validateAuthorizationToken(value, requestedScopes, requestedClientName) {
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

export function isReadyResponse(value) {
  return value?.ready === true || value?.status === "ok" || value?.status === "ready";
}

export async function revokeIssuedCredential(apiUrl, accessToken, dependencies) {
  if (typeof accessToken !== "string" || accessToken.length < 32) return;
  try {
    await dependencies.clientFactory({ apiUrl, token: accessToken }).revokeAuth();
  } catch {
    // The original failure remains authoritative; never expose the issued token in diagnostics.
  }
}

function loginSettings(options, dependencies) {
  // Logins are upserted by (owner, name): naming each after its computer keeps two machines apart.
  const clientName = requireText(
    options["client-name"] ?? Array.from(dependencies.computerName?.() || "Relo CLI").slice(0, 80).join(""),
    "--client-name", 80,
  );
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
  return { clientName, scopes, expiresInSeconds };
}

/** How long one `--wait` may block: 100s in an agent context (its shell tool kills longer commands), else 10m. */
function waitSeconds(options, dependencies) {
  return parseDuration(options.timeout ?? (inAgentContext(dependencies.env) ? "100s" : "10m"), { maximumSeconds: 600 });
}

/**
 * Polls the device authorization until approved, denied, expired, or `deadline`. On approval the
 * credential is stored; the pending record (if any) is cleared on every terminal outcome.
 * Returns the sign-in result, or undefined when the deadline passed with the owner still deciding.
 */
async function pollAuthorization({ client, apiUrl, deviceCode, intervalSeconds, scopes, clientName, deadline,
  expectedConfigRevision, pollFirst, profile, dependencies }) {
  const path = dependencies.configPath();
  const settle = () => dependencies.pendingLogin.clear();
  let interval = intervalSeconds;
  let first = pollFirst;
  while (dependencies.now() < deadline) {
    if (!first) {
      await dependencies.sleep(Math.min(interval * 1_000, Math.max(0, deadline - dependencies.now())));
      if (dependencies.now() >= deadline) break;
    }
    first = false;

    let response;
    try {
      response = await client.pollDeviceAuthorization(deviceCode);
    } catch (error) {
      if (error instanceof NetworkError || (error instanceof ApiError && error.status >= 500)) {
        continue;
      }
      if (!(error instanceof ApiError)) throw error;
      const code = error.code.toLowerCase();
      if (code === "authorization_pending") {
        interval = Math.max(interval, Number(error.details?.intervalSeconds) || interval);
        continue;
      }
      if (code === "slow_down" || code === "rate_limited") {
        const serverInterval = Number(error.details?.intervalSeconds) || 0;
        const retryAfter = Number(error.details?.retryAfterSeconds) || 0;
        interval = Math.max(interval + (code === "slow_down" ? 5 : 0), serverInterval, retryAfter);
        continue;
      }
      if (code === "access_denied") {
        await settle();
        throw authFlowError("Authorization was denied.", "ACCESS_DENIED", EXIT.NEGATIVE);
      }
      if (code === "expired_token") {
        await settle();
        throw authFlowError("Authorization expired.", "AUTHORIZATION_EXPIRED", EXIT.TERMINAL, {
          hint: "Start over: relo auth login --no-wait",
        });
      }
      if (code === "invalid_grant") {
        await settle();
        throw new AuthError("Authorization grant is no longer valid.", { code: "INVALID_GRANT" });
      }
      throw error;
    }

    const accessToken = response?.accessToken;
    try {
      const issued = validateAuthorizationToken(response, scopes, clientName);
      // A new login on the same server keeps what the old one learned (the first phone test).
      let previous;
      try { previous = await dependencies.loadConfig(path); } catch { previous = undefined; }
      const sameServer = previous?.apiUrl === apiUrl;
      await dependencies.writeConfig(path, {
        version: 1,
        ...(profile === undefined ? {} : { profile }),
        apiUrl,
        token: issued.accessToken,
        principal: {
          id: issued.credential.id,
          name: issued.credential.clientName,
          scopes: issued.credential.scopes,
          expiresAt: issued.credential.expiresAt ?? null,
        },
        accounts: dependencies.loadAccounts?.() ?? {},
        ...(sameServer && previous.phoneTest ? { phoneTest: previous.phoneTest } : {}),
      }, { expectedRevision: expectedConfigRevision });
      await settle();
      return result("auth.login", {
        authenticated: true,
        apiUrl,
        credential: issued.credential,
        ...(profile === undefined ? {} : { profile }),
        configPath: path,
      });
    } catch (error) {
      await revokeIssuedCredential(apiUrl, accessToken, dependencies);
      throw error;
    }
  }
  return undefined;
}

const PENDING_NEXT = "relo auth login --wait";

/** The server a new profile signs in to: the profile's own, else the active profile's. */
async function loadForOrigin(dependencies) {
  try {
    return await dependencies.loadConfig(dependencies.configPath());
  } catch (error) {
    if (!(error instanceof AuthError && error.code === "PROFILE_NOT_FOUND")) throw error;
    const keep = dependencies.profile;
    dependencies.profile = undefined;
    try { return await dependencies.loadConfig(dependencies.configPath()); } finally { dependencies.profile = keep; }
  }
}

export async function login(options, dependencies) {
  if (options.open && options["no-open"]) {
    throw new UsageError("--open and --no-open cannot be used together");
  }
  if (options.wait && options["no-wait"]) {
    throw new UsageError("--wait and --no-wait cannot be used together");
  }
  if (options.wait) return resumeLogin(options, dependencies);
  const { clientName, scopes, expiresInSeconds } = loginSettings(options, dependencies);
  const timeoutSeconds = parseDuration(options.timeout ?? "10m", { maximumSeconds: 600 });
  // An agent's shell shows output only when the command ends, so a blocking login hides the link.
  const agentDefault = !options["no-wait"] && inAgentContext(dependencies.env) && options.timeout === undefined;
  const detach = Boolean(options["no-wait"]) || agentDefault;
  const profile = dependencies.profile;
  let trustedOrigin = options["api-url"] ?? dependencies.env.RELO_API_URL;
  if (trustedOrigin === undefined) {
    try {
      trustedOrigin = (await loadForOrigin(dependencies)).apiUrl;
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

  if (detach) {
    await dependencies.pendingLogin.write({
      version: 1, apiUrl, deviceCode: started.deviceCode, userCode: started.userCode,
      url: started.verificationUriComplete, clientName, scopes,
      ...(profile === undefined ? {} : { profile }),
      intervalSeconds: started.intervalSeconds,
      expiresAtMs: dependencies.now() + started.expiresInSeconds * 1_000,
    });
    if (options.open) {
      try { dependencies.openBrowser(started.verificationUriComplete); } catch { /* the owner has the link */ }
    }
    return result("auth.login", {
      authenticated: false, state: "pending", url: started.verificationUriComplete,
      code: started.userCode, next: PENDING_NEXT,
    }, agentDefault ? {
      message: "Not waiting, because an agent shell shows output only when a command ends. Give the owner the url, then run: relo auth login --wait",
    } : undefined);
  }

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
  const outcome = await pollAuthorization({ client, apiUrl, deviceCode: started.deviceCode,
    intervalSeconds: started.intervalSeconds, scopes, clientName, deadline, expectedConfigRevision,
    pollFirst: false, profile, dependencies });
  if (outcome !== undefined) return outcome;
  throw authFlowError(
    "Authorization timed out.",
    "AUTHORIZATION_TIMEOUT",
    EXIT.TERMINAL,
  );
}

/** `relo auth login --wait`: resume the sign-in that `--no-wait` started. */
async function resumeLogin(options, dependencies) {
  const pending = await dependencies.pendingLogin.read();
  if (!pending) {
    throw new UsageError("No sign-in is waiting.", { hint: "Start one: relo auth login --no-wait" });
  }
  if (dependencies.now() >= pending.expiresAtMs) {
    await dependencies.pendingLogin.clear();
    throw authFlowError("The sign-in link expired before it was approved.", "AUTHORIZATION_EXPIRED", EXIT.TERMINAL, {
      state: "expired", hint: "Start over: relo auth login --no-wait",
    });
  }
  const path = dependencies.configPath();
  const deadline = Math.min(dependencies.now() + waitSeconds(options, dependencies) * 1_000, pending.expiresAtMs);
  const outcome = await pollAuthorization({
    client: dependencies.clientFactory({ apiUrl: pending.apiUrl }), apiUrl: pending.apiUrl,
    deviceCode: pending.deviceCode, intervalSeconds: pending.intervalSeconds, scopes: pending.scopes,
    clientName: pending.clientName, deadline, expectedConfigRevision: await dependencies.configRevision(path),
    pollFirst: true, profile: typeof pending.profile === "string" ? pending.profile : dependencies.profile, dependencies,
  });
  if (outcome !== undefined) return outcome;
  if (dependencies.now() >= pending.expiresAtMs) {
    await dependencies.pendingLogin.clear();
    throw authFlowError("The sign-in link expired before it was approved.", "AUTHORIZATION_EXPIRED", EXIT.TERMINAL, {
      state: "expired", hint: "Start over: relo auth login --no-wait",
    });
  }
  throw authFlowError("Still waiting for the owner to approve the sign-in.", "AUTHORIZATION_PENDING", EXIT.TERMINAL, {
    state: "pending", hint: "Ask the owner to open the link, then run again: relo auth login --wait",
  });
}

/** Runs this group's commands; returns undefined when the command is not one of them. */
export async function runAuthCommand(command) {
  const { options, group, action, rest, dependencies } = command;
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
      credentialSource: config.source ?? "config",
      ...(config.profile === undefined ? {} : { profile: config.profile, profiles: config.profiles }),
      configPath: config.path,
    });
  }

  if (group === "auth" && action === "switch") {
    assertNoExtra(rest, 1, "Usage: relo auth switch NAME");
    assertAllowedOptions(options, []);
    const switched = await dependencies.switchProfile(dependencies.configPath(), rest[0]);
    const message = dependencies.env.RELO_PROFILE
      ? "RELO_PROFILE is set and overrides the active profile until it is unset." : undefined;
    return result("auth.switch", switched, message ? { message } : undefined);
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
      "wait",
      "no-wait",
      "profile",
    ]);
    const output = await login(options, dependencies);
    if (dependencies.env.RELO_TOKEN) {
      output.message = [output.message, "RELO_TOKEN is set and overrides this login until it is unset."]
        .filter(Boolean).join(" ");
    }
    return output;
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
    if (config.source === "environment") {
      throw new UsageError("This credential comes from RELO_TOKEN, not a local login.", {
        hint: "Unset RELO_TOKEN, or revoke the client in the Relo dashboard under Connections",
      });
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
      ...(config.profile === undefined ? {} : { profile: config.profile }),
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
  return undefined;
}
