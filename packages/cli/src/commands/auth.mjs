import { spawn } from "node:child_process";
import { platform } from "node:os";
import { parseDuration, requireText } from "../args.mjs";
import { normalizeApiUrl } from "../config.mjs";
import { ApiError, AuthError, EXIT, NetworkError, ReloError, UsageError, normalizeError } from "../errors.mjs";
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

export async function login(options, dependencies) {
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
