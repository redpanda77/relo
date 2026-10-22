import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { platform } from "node:os";
import { assertNoExtra, parseDuration, requireText } from "../shared/validate.mjs";
import { normalizeApiUrl } from "../shared/config.mjs";
import { ApiError, AuthError, EXIT, NetworkError, ReloError, UsageError, normalizeError } from "../shared/errors.mjs";
import { waitsShort } from "../caller.mjs";
import { getAuthenticated } from "../shared/login.mjs";
import { result } from "../shared/outcome.mjs";
import { qrText } from "../shared/qr.mjs";
import { isReadyResponse, safeCredential } from "./credential-shape.mjs";
import { joinRedeemFailure, joinSummary } from "./join.mjs";
import { publishJoinKey } from "../crypto/trust.mjs";
import { ensureIdentity, keyStorePath } from "../crypto/keystore.mjs";
import { signinNumber } from "../crypto/signin-number.mjs";
import { ephemeralEnvironment } from "../harness/catalog.mjs";
import { LOGIN_SCOPES } from "../shared/scopes.generated.mjs";

// A login asks for every scope the registry lets a login hold (contracts scopes.ts, generated); --scope narrows it.
const DEFAULT_LOGIN_SCOPES = [...LOGIN_SCOPES];
const ALLOWED_LOGIN_SCOPES = new Set(LOGIN_SCOPES);

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

/** Opens Relo for Mac (the notch app) at `path` with launch arguments; it reads them once, at start. */
export function openMacApp(path, args) {
  const child = spawn("open", [path, "--args", ...args], { detached: true, shell: false, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function authFlowError(message, code, exitCode, details) {
  return new ReloError(message, { code, exitCode, details });
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

async function revokeIssuedCredential(apiUrl, accessToken, dependencies) {
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
  return parseDuration(options.timeout ?? (waitsShort(dependencies.caller) ? "100s" : "10m"), { maximumSeconds: 600 });
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
        throw authFlowError("Authorization expired.", "AUTHORIZATION_EXPIRED", EXIT.CLOSED, {
          hint: "Start over: relo auth login --no-wait",
        });
      }
      if (code === "invalid_grant") {
        await settle();
        throw new AuthError("Authorization grant is no longer valid.", { code: "INVALID_GRANT" });
      }
      throw error;
    }

    const saved = await saveIssuedLogin({ response, apiUrl, scopes, clientName, profile, expectedConfigRevision, dependencies });
    await settle();
    return saved;
  }
  return undefined;
}

/**
 * Saves the login a sign-in issued (the device authorization's token, or a redeemed one-time code) and returns the
 * auth.login result. A response that does not match what was asked is revoked, never saved.
 */
async function saveIssuedLogin({ response, apiUrl, scopes, clientName, profile, expectedConfigRevision, dependencies }) {
  const path = dependencies.configPath();
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

/** A cloud sandbox is not a computer: a login there would be a stray computer on the owner's phone. Before any network call. */
function refuseCloudSandbox(dependencies) {
  const sandbox = ephemeralEnvironment(dependencies.env);
  if (!sandbox) return;
  throw new UsageError(`This looks like a cloud sandbox (${sandbox.label}), not a computer. Use a CI token there: set RELO_API_URL and RELO_TOKEN.`);
}

/**
 * `relo auth join CODE`: Add a computer (docs/site/guides/servers.md). Redeems a one-time code a trusted device made
 * for this computer's own login (no browser), saves it like a sign-in, and says how the owner wants it set up.
 */
export async function join(options, fullCode, dependencies) {
  refuseCloudSandbox(dependencies);
  // `rci_<redeem>.<bind>`: the server sees only the redeem half; the bind half vouches for this computer's key and is
  // never stored or printed (docs/ENCRYPTION-PROTOCOL.md, "Key binding").
  const [code, bind, ...extra] = String(fullCode ?? "").split(".");
  if (extra.length > 0 || (bind !== undefined && !/^[A-Za-z0-9_-]{22}$/u.test(bind)) || !/^rci_[A-Za-z0-9_-]{32}$/u.test(code)) {
    throw new UsageError("That is not a Relo join code.", { hint: "Copy the whole command from Add a computer on your iPhone, Mac or the Dashboard." });
  }
  const { clientName, scopes, expiresInSeconds } = loginSettings(options, dependencies);
  let trustedOrigin = options["api-url"] ?? dependencies.env.RELO_API_URL;
  if (trustedOrigin === undefined) {
    try { trustedOrigin = (await loadForOrigin(dependencies)).apiUrl; } catch { /* named below */ }
  }
  if (trustedOrigin === undefined) throw new UsageError("Relo server origin is required; use --api-url");
  const apiUrl = normalizeApiUrl(trustedOrigin);
  const expectedConfigRevision = await dependencies.configRevision(dependencies.configPath());
  // A code means switch: the login it replaces is named afterwards, never asked about.
  let left;
  try { left = await dependencies.loadConfig(dependencies.configPath()); } catch { left = undefined; }
  // The Mac app the install script just put in place (--mac-app): the redeem asks for its sign-in code with a PKCE
  // challenge, and only the app is handed the verifier.
  const macApp = typeof options["mac-app"] === "string" && dependencies.platform === "darwin" ? options["mac-app"] : undefined;
  const macVerifier = macApp ? randomBytes(32).toString("base64url") : undefined;
  const macAppChallenge = macVerifier ? createHash("sha256").update(macVerifier).digest("base64url") : undefined;
  let response;
  try {
    response = await dependencies.clientFactory({ apiUrl })
      .redeemComputerInvite({ code, clientName, scopes, expiresInSeconds, ...(macAppChallenge ? { macAppChallenge } : {}) });
  } catch (error) {
    throw joinRedeemFailure(error, apiUrl);
  }
  if (typeof response?.accessToken !== "string") throw joinRedeemFailure(undefined, apiUrl);
  const saved = await saveIssuedLogin({ response, apiUrl, scopes, clientName, profile: undefined, expectedConfigRevision, dependencies });
  // Publish the identity key now so the binding goes with it; a failure here is retried, unbound, by the next command.
  try {
    const config = { apiUrl, token: response.accessToken };
    await publishJoinKey({ client: dependencies.clientFactory(config), config, clientId: response.credential?.id, bind, dependencies });
  } catch { /* ensureTrust publishes it later, without a binding: the owner approves this computer the ordinary way */ }
  const level = ["notify", "track", "guide", "optimize"].includes(response?.setup?.level) ? response.setup.level : "track";
  // The agents the owner picked; none named: every agent this computer has.
  const agents = Array.isArray(response?.setup?.agents) ? response.setup.agents.filter((id) => typeof id === "string" && /^[a-z][a-z0-9-]{1,30}$/u.test(id)) : [];
  // Named only when it left another server: locally a login knows its server, not its account.
  const leftLogin = left && left.source !== "environment" && left.apiUrl && left.apiUrl !== apiUrl
    ? { server: left.apiUrl, name: left.principal?.name } : undefined;
  let mac;
  if (macApp) {
    const signInCode = typeof response?.macAppSignInCode === "string" ? response.macAppSignInCode : undefined;
    try {
      await dependencies.openMacApp(macApp, signInCode
        ? ["--relo-origin", apiUrl, "--relo-sign-in-code", signInCode, "--relo-code-verifier", macVerifier]
        : ["--relo-origin", apiUrl]);
      mac = signInCode ? "signed-in" : "opened";
    } catch {
      mac = "not-opened";
    }
  }
  return { saved, clientName, left: leftLogin, setup: { level, approvals: response?.setup?.approvals === true, agents }, ...(mac ? { mac } : {}) };
}

const PENDING_NEXT = "relo auth login --wait";
// Device authorization (RFC 8628): the owner approves this computer on a device already signed in. The link opens
// the server's approval page; its QR code is scanned with the Relo app on the owner's iPhone (approve there) or
// with any phone camera (the page again).
const SCAN_HINT = "Scan it with the Relo app on your iPhone to approve, or with your phone's camera to open the link.";

const APPROVE_HINT = "Approve it in the Relo app (scan or type the code) or open the link.";

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
  refuseCloudSandbox(dependencies);
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
  const agentDefault = !options["no-wait"] && waitsShort(dependencies.caller) && options.timeout === undefined;
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
  // The identity key first: the server relays it to the approving device, which shows the number computed from it.
  const { store } = await ensureIdentity(keyStorePath(path, dependencies.env), { now: dependencies.now() });
  const identityKey = store.identity.publicKey;
  const started = validateAuthorizationStart(
    await client.startDeviceAuthorization({ clientName, scopes, expiresInSeconds, identityKey }),
    apiUrl,
  );
  const number = signinNumber(started.userCode, identityKey);

  if (detach) {
    await dependencies.pendingLogin.write({
      version: 1, apiUrl, deviceCode: started.deviceCode, userCode: started.userCode,
      url: started.verificationUriComplete, number, clientName, scopes,
      ...(profile === undefined ? {} : { profile }),
      intervalSeconds: started.intervalSeconds,
      expiresAtMs: dependencies.now() + started.expiresInSeconds * 1_000,
    });
    if (options.open) {
      try { dependencies.openBrowser(started.verificationUriComplete); } catch { /* the owner has the link */ }
    }
    const qr = qrText(started.verificationUriComplete);
    return result("auth.login", {
      authenticated: false, state: "pending", url: started.verificationUriComplete,
      code: started.userCode, number, ...(qr ? { qr } : {}), next: PENDING_NEXT,
    }, agentDefault ? {
      message: "Not waiting, because an agent shell shows output only when a command ends. Show the owner the url, the qr "
        + "(in a code block), the code and the number: they open the link, or scan the QR code (or type the code) in the Relo app on their iPhone, pick the number and approve. Then run: relo auth login --wait",
    } : undefined);
  }

  dependencies.stderr("Open this link to connect the Relo CLI:");
  dependencies.stderr(started.verificationUriComplete);
  const qr = qrText(started.verificationUriComplete);
  if (qr) {
    dependencies.stderr("");
    dependencies.stderr(qr);
    dependencies.stderr(SCAN_HINT);
    dependencies.stderr("");
  }
  dependencies.stderr(`Fallback page: ${started.verificationUri}`);
  dependencies.stderr(`Fallback code: ${started.userCode}`);
  dependencies.stderr(`Number on your phone: ${number}`);
  dependencies.stderr(APPROVE_HINT);
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
    throw authFlowError("The sign-in link expired before it was approved.", "AUTHORIZATION_EXPIRED", EXIT.CLOSED, {
      state: "expired", hint: "Start over: relo auth login --no-wait",
    });
  }
  if (typeof pending.number === "string") {
    dependencies.stderr(`Code ${pending.userCode}. Number on your phone: ${pending.number}`);
    dependencies.stderr(APPROVE_HINT);
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
    throw authFlowError("The sign-in link expired before it was approved.", "AUTHORIZATION_EXPIRED", EXIT.CLOSED, {
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
    const switched = await dependencies.switchProfile(dependencies.configPath(), rest[0]);
    const message = dependencies.env.RELO_PROFILE
      ? "RELO_PROFILE is set and overrides the active profile until it is unset." : undefined;
    return result("auth.switch", switched, message ? { message } : undefined);
  }

  if (group === "auth" && action === "login") {
    assertNoExtra(rest, 0, "Usage: relo auth login [options]");
    const output = await login(options, dependencies);
    if (output.data?.authenticated === true) await dependencies.sendMachineReport?.();
    if (dependencies.env.RELO_TOKEN) {
      output.message = [output.message, "RELO_TOKEN is set and overrides this login until it is unset."]
        .filter(Boolean).join(" ");
    }
    return output;
  }

  if (group === "auth" && action === "invite") {
    assertNoExtra(rest, 0, "Usage: relo auth invite [--level LEVEL] [--approvals on|off] [--with-mac-app]");
    const { client } = await getAuthenticated(dependencies);
    const agents = [options.agent ?? []].flat();
    const { harnessFor } = await import("../harness/catalog.mjs");
    const unknown = agents.filter((name) => !harnessFor(name));
    if (unknown.length) throw new UsageError(`Unknown agent "${unknown[0]}".`, { hint: "Name one of: claude-code, codex, opencode, gemini, cursor, copilot, amp" });
    const invite = await client.createComputerInvite({
      ...(options.level ? { level: options.level } : {}), ...(options.approvals ? { approvals: options.approvals === "on" } : {}),
      ...(agents.length ? { agents: [...new Set(agents.map((name) => harnessFor(name).id))] } : {}),
      ...(options["with-mac-app"] ? { macApp: true } : {}),
    });
    return result("auth.invite", { command: invite.command, expiresAt: invite.expiresAt, level: invite.level, approvals: invite.approvals,
      agents: invite.agents ?? null, macApp: invite.macApp === true },
      { message: "Paste the command on the new computer. It works once, for 30 minutes." });
  }

  if (group === "auth" && action === "join") {
    assertNoExtra(rest, 1, "Usage: relo auth join CODE [--api-url URL] [--client-name NAME] [--mac-app PATH]");
    const joined = await join(options, rest[0], dependencies);
    const apiUrl = joined.saved.data.apiUrl;
    dependencies.stderr?.(`Signed in to ${apiUrl} as ${joined.clientName}. Setting up this computer's agents…`);
    // A code is never a person at a terminal: setup must not ask, even when stdout happens to be a TTY.
    const quiet = { ...dependencies, stdinIsTTY: false, stdoutIsTTY: false };
    // Set up the way the owner chose when making the code; the computer's name is the one it signed in with.
    const { chooseHarnesses } = await import("../install/plan.mjs");
    const { harnessFor } = await import("../harness/catalog.mjs");
    const { env, home, cwd, platform } = dependencies;
    const agents = joined.setup.agents.filter((id) => harnessFor(id));
    let outcome;
    // No agent here yet (and none picked): signed in all the same; setup runs once one is installed.
    if (agents.length === 0 && chooseHarnesses([], { env, home, cwd, platform }).length === 0) {
      outcome = result("auth.login", joined.saved.data, { message: `Signed in. No agent is installed here yet: install an agent (Claude Code, Codex, OpenCode, Gemini CLI, Cursor, Copilot), then run relo setup --level ${joined.setup.level}${joined.setup.approvals ? " --approvals on" : ""}.` });
    } else {
      const { runSetupCommand } = await import("./setup.mjs");
      outcome = await runSetupCommand({
        options: { agent: agents, level: joined.setup.level, approvals: joined.setup.approvals ? "on" : "off", computer: joined.clientName },
        action: undefined, rest: [], dependencies: quiet,
      });
    }
    const summary = await joinSummary({ joined, apiUrl, dependencies: quiet, outcome });
    return { ...outcome, data: { ...outcome.data, join: summary.data }, text: summary.lines.join("\n") };
  }

  if (group === "auth" && action === "logout") {
    assertNoExtra(rest, 0, "Usage: relo auth logout");
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
        hint: "Unset RELO_TOKEN, or revoke the computer in the Relo dashboard under Connections → Computers",
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
