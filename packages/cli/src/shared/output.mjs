// What an agent reads back: one compact JSON line per command, and each error exactly once.
// `--full` prints the whole server envelope instead. printOutcome and printFailure are the whole output
// contract; nothing else in the CLI decides what goes to stdout or stderr.
import { ApiError, AuthError, NetworkError, TerminalInteractionError, normalizeError } from "./errors.mjs";
import { WorkRefusal, refusalText } from "../work/refusal.mjs";
import { LOGIN_SCOPES } from "./scopes.generated.mjs";

const present = (fields) => Object.fromEntries(
  Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
);

/** "2/5": the step a card is on, from the steps component the server returns. */
/** Short words for `relo keys status` notices. */
const NOTICE_LABELS = { security_code_changed: "security code changed", new_phone: "waiting for approval: relo keys approve, or approve it in Relo on your trusted iPhone → Settings → Devices",
  new_phone_approved: "approved on your phone", approved_from_browser: "approved from a linked browser", browser_linked: "linked from your phone",
  phone_replaced: "phone set up again" };

function stepPosition(activity) {
  const steps = activity?.presentation?.components?.find((component) => component?.type === "steps");
  const items = Array.isArray(steps?.items) ? steps.items : [];
  if (items.length === 0) return undefined;
  const current = items.findIndex((item) => item?.state === "current");
  const done = items.filter((item) => item?.state === "complete").length;
  return `${current === -1 ? done : current + 1}/${items.length}`;
}

function cardFields(activity) {
  return {
    id: activity?.id,
    state: activity?.state,
    sequence: activity?.sequence,
    step: stepPosition(activity),
    progress: activity?.progress,
  };
}

function interactionFields(data) {
  const interaction = data?.interaction ?? data;
  // A choice answered with one of its options reads as "chosen" with that option's id and label.
  const chosen = interaction?.type === "choice" && typeof interaction?.response?.optionId === "string"
    ? interaction.response : undefined;
  return {
    id: interaction?.id,
    state: chosen ? "chosen" : interaction?.state ?? interaction?.status,
    ...(chosen ? { option: chosen.optionId, label: chosen.label } : {}),
    response: typeof interaction?.response === "string" ? interaction.response : undefined,
    // A phone's signature on the approval was checked (end-to-end encryption, E4.2).
    verified: data?.verified === true ? true : undefined,
  };
}

const DOCTOR_HINTS = {
  localConfig: "Run: relo auth login --api-url https://YOUR-RELO-SERVER",
  server: "Check the network and RELO_API_URL.",
  auth: "Sign in again: relo auth login",
  runtime: "The server reports a problem: relo doctor --full",
  smoke: "No phone confirmed the test: relo doctor --full",
};

/** Only what needs attention, each with its next step; a healthy setup is just {"ok":true}. */
function doctorFields(data) {
  const problems = Object.entries(data?.checks ?? {}).filter(([, check]) => check?.ok !== true && check?.state !== "skipped");
  const advice = Object.entries(data?.warnings ?? {}).filter(([name, check]) => check?.ok !== true
    && !(name === "skill" && data?.next?.step === "skill"));
  return {
    ok: data?.ok === true,
    ready: data?.ready === true,
    ...(data?.next ? { next: data.next } : {}),
    ...(data?.privacy ? { privacy: data.privacy } : {}),
    ...(problems.length === 0 ? {} : {
      checks: Object.fromEntries(problems.map(([name, check]) => [name, present({
        state: check?.state ?? check?.error,
        // A login `next.run` is the one sign-in instruction; a second login hint would compete with it.
        hint: data?.next?.step === "login" && (name === "localConfig" || name === "auth") ? undefined : name === "auth" && check?.state === "activity_evidence_scope_missing"
          ? "Missing devices:read: relo auth login" : DOCTOR_HINTS[name],
      })])),
    }),
    ...(advice.length === 0 ? {} : {
      warnings: Object.fromEntries(advice.map(([name, check]) => [name, present({ state: check.state, latest: check.latest, hint: check.hint })])),
    }),
  };
}

// What agent work needs: every login scope except managing services and computer credentials.
const REQUIRED_SCOPES = LOGIN_SCOPES.filter((scope) => !scope.startsWith("services:"));

function authFields(data) {
  const credential = data?.credential;
  const missing = REQUIRED_SCOPES.filter((scope) => Array.isArray(credential?.scopes) && !credential.scopes.includes(scope));
  return present({
    signedIn: data?.authenticated === true,
    server: data?.apiUrl,
    client: credential?.clientName,
    expiresAt: credential?.expiresAt,
    source: data?.credentialSource === "environment" ? "RELO_TOKEN" : undefined,
    profile: data?.profile,
    missingScopes: missing.length > 0 ? missing : undefined,
    hint: missing.length > 0 ? "Sign in again to get every permission: relo auth login" : undefined,
  });
}

const cardRow = (activity) => present({
  id: activity?.id,
  state: activity?.state,
  title: activity?.title,
  status: activity?.status,
  step: stepPosition(activity),
  progress: activity?.progress,
  updatedAt: activity?.updatedAt,
});

const sessionRow = (session) => present({
  harness: session?.harness,
  computer: session?.computer,
  account: session?.account,
  project: session?.project,
  phase: session?.phase,
  waitingFor: session?.waitingFor,
  lastSeenAt: session?.lastSeenAt,
  card: session?.card ? present({ state: session.card.state }) : undefined,
});

const serviceRow = (service) => present({
  id: service?.id,
  title: service?.title,
  prefix: service?.prefix,
  readable: service?.readableAllowed === true ? true : undefined,
  createdAt: service?.createdAt,
});

const deviceRow = (device) => present({
  id: device?.deviceId ?? device?.id,
  name: device?.name,
  liveActivities: typeof device?.liveActivityAuthorization === "string"
    ? device.liveActivityAuthorization === "authorized" : undefined,
  lastSeenAt: device?.lastSeenAt,
});

/** One small object holding only what the caller acts on; undefined means "print it in full". */
export function compactData(command, data) {
  switch (command) {
    case "activity.start":
    case "activity.update":
    case "activity.end":
    case "activity.get":
      if (data?.found === false) return { found: false };
      return present({
        found: data?.found === true ? true : undefined,
        ...cardFields(data?.activity),
        disposition: data?.disposition,
        reused: data?.reused === true ? true : undefined,
        held: data?.heldForQuestion === true ? true : undefined,
        next: data?.disposition === "continuing" ? data?.next : undefined,
      });
    case "activity.status":
      return data?.found === false || !data?.activity
        ? { found: false }
        : present({ found: true, ...cardFields(data.activity) });
    case "activity.list":
      return { cards: (Array.isArray(data?.activities) ? data.activities : []).map(cardRow) };
    case "devices.list":
      return { devices: (Array.isArray(data?.devices) ? data.devices : []).map(deviceRow) };
    case "keys.status":
      return present({
        identity: data?.identity?.keyId,
        required: data?.required === true ? true : undefined,
        strict: data?.strict === true ? true : undefined,
        strictSource: data?.strict === true && data?.strictSource === "address" ? "public server address" : undefined,
        devices: (Array.isArray(data?.devices) ? data.devices : []).map((device) =>
          present({ id: device.deviceId, name: device.name, model: device.model, simulator: device.simulator, handle: device.handle,
            trust: device.trust, prekey: device.prekey, lastSeenAt: device.lastSeenAt,
            notice: device.notice ? NOTICE_LABELS[device.notice.kind] ?? "security code changed" : undefined })),
      });
    case "keys.approve":
      return present({ id: data?.deviceId, name: data?.name, trust: data?.trust, approved: data?.approved });
    case "keys.remove":
      return present({ id: data?.deviceId, name: data?.name, removed: data?.removed, where: data?.where });
    case "keys.verify":
      return present({ id: data?.deviceId, trust: data?.trust, safetyNumber: data?.safetyNumber });
    case "keys.require":
      return present({ required: data?.required, mode: data?.mode, changed: data?.changed });
    case "keys.strict":
      return present({ strict: data?.strict, source: data?.source, changed: data?.changed });
    case "keys.forget":
      return present({ id: data?.deviceId, removed: data?.removed });
    case "keys.rotate":
      return present({ rotated: data?.rotated, keyId: data?.keyId, previous: data?.previous });
    case "doctor":
      return doctorFields(data);
    case "auth.invite":
      return present({ command: data?.command, expiresAt: data?.expiresAt, level: data?.level, approvals: data?.approvals, agents: data?.agents ?? undefined });
    case "auth.status":
    case "auth.login":
      if (data?.state === "pending") return present({ state: "pending", url: data.url, code: data.code, qr: data.qr, next: data.next });
      return authFields(data);
    case "test":
      return present({ verified: data?.verified === true, already: data?.already === true ? true : undefined });
    case "auth.logout":
      return present({
        revoked: data?.revoked,
        credentialsRemoved: data?.credentialsRemoved,
        alreadyLoggedOut: data?.alreadyLoggedOut === true ? true : undefined,
        revocationError: data?.revocationError,
      });
    case "services.list":
      return { services: (Array.isArray(data?.services) ? data.services : []).map(serviceRow) };
    case "services.edit": {
      const service = data?.service ?? data;
      return present({ id: service?.id, title: service?.title, scopes: service?.scopes, readableAllowed: service?.readableAllowed });
    }
    case "auth.token.list":
      return { tokens: (Array.isArray(data?.tokens) ? data.tokens : []).map((token) => present({ id: token?.id, name: token?.name, scopes: token?.scopes, expiresAt: token?.expiresAt, lastUsedAt: token?.lastUsedAt })) };
    case "auth.token.create":
    case "auth.token.rotate":
      return present({ id: data?.credential?.id, name: data?.credential?.name, expiresAt: data?.credential?.expiresAt, token: data?.token,
        secretFileWritten: data?.secretFileWritten === true ? true : undefined, secretFileName: data?.secretFileName });
    case "auth.token.revoke":
    case "services.revoke":
      return present({ id: data?.id, revoked: data?.revoked });
    case "services.create":
    case "services.rotate": {
      const service = data?.service ?? data;
      return present({
        id: service?.id,
        title: service?.title,
        prefix: service?.prefix,
        endpoint: data?.endpoint,
        secret: data?.secret,
        secretFileWritten: data?.secretFileWritten === true ? true : undefined,
        secretFileName: data?.secretFileName,
      });
    }
    case "setup":
    case "uninstall": {
      // Unchanged rows stay behind --full: the line says what changed, what was skipped and what is next.
      const rows = (list) => (Array.isArray(list) && list.length ? list : undefined);
      // setup leads with its depth; --show reads, so it has the installed harnesses (and `would` for --level) instead of rows.
      return present({ depth: data?.depth, show: data?.show === true ? true : undefined, harnesses: data?.harnesses, would: data?.would,
        changed: data?.show ? undefined : data?.changed ?? [], unchanged: data?.unchanged?.length, skipped: rows(data?.skipped), errors: rows(data?.errors), next: data?.next,
        harnessCredential: data?.harnessCredential, block: data?.block, join: data?.join, dryRun: data?.dryRun === true ? true : undefined });
    }
    case "sessions":
      return present({ sessions: (Array.isArray(data?.sessions) ? data.sessions : []).map(sessionRow),
        counts: data?.counts && typeof data.counts === "object" ? data.counts : undefined });
    case "hook":
      return {};
    case "dry-run":
      return { dryRun: true, would: data?.would };
    case "auth.switch":
      return present({ profile: data?.profile, profiles: data?.profiles });
    case "ask":
      return present({
        ...interactionFields(data),
        card: data?.card?.id,
        fallback: data?.fallback,
      });
    case "interaction.get":
    case "interaction.wait":
    case "interaction.cancel":
      return present(interactionFields(data));
    case "notify.send":
      return present({
        id: data?.eventId,
        devices: data?.delivery?.eligibleDevices,
        replayed: data?.replayed === true ? true : undefined,
      });
    case "notify.withdraw":
      return present({ id: data?.eventId, state: data?.state });
    case "config":
      return { settings: (Array.isArray(data?.settings) ? data.settings : []).map((row) => present({ key: row.key, value: row.value, source: row.source })) };
    case "account":
    case "project":
    case "voice":
      return { ...data };
    case "update":
      return present({ ...data });
    default:
      return undefined;
  }
}

function successLine(output, { full, note }) {
  const compact = full ? undefined : compactData(output.command, output.data);
  if (compact === undefined) return { ok: output.exitCode === 0, command: output.command, data: output.data };
  return { ok: true, ...compact, ...(note ? { note } : {}) };
}

const START_HINT = "Start a new one: relo work start --goal …";

const NOUN = { activity: "card", interaction: "question", ask: "question", notify: "notification" };

/** Server codes in plain English, with the next command to try. Anything unlisted passes through. */
function friendly(error, group) {
  const wait = error.details?.retryAfterSeconds;
  const noun = NOUN[group] ?? "item";
  switch (error.code) {
    case "TURN_OFF_IN_DASHBOARD":
    case "turn_off_in_dashboard":
      return { message: "Turning end-to-end encryption off needs the owner signed in to the Dashboard.",
        hint: "Open the Relo Dashboard → Account → Security; computers can only turn it on" };
    case "END_TO_END_REQUIRED":
    case "end_to_end_required":
      return { message: "This account requires end-to-end encryption and this computer could not seal the content.",
        hint: "Verify a phone: relo keys status, then relo keys verify DEVICE_ID (a person at a terminal)" };
    case "SESSIONS_UNSUPPORTED":
      return { message: error.message };
    case "ACTIVITY_TERMINAL":
    case "ACTIVITY_NOT_ACTIVE":
      return { message: "This card already ended.", hint: START_HINT };
    case "NOT_FOUND":
    case "ACTIVITY_NOT_FOUND":
    case "NOTIFICATION_NOT_FOUND":
      return group === "activity" || error.code === "ACTIVITY_NOT_FOUND"
        ? { message: "No such card.", hint: START_HINT }
        : { message: `No such ${noun}.`, hint: "Check the ID; it must come from this Relo server." };
    case "SEQUENCE_CONFLICT":
      return { message: "The card changed since you last read it.", hint: "Retry without --if-sequence, or read it first: relo activity status" };
    case "IDEMPOTENCY_CONFLICT":
      return { message: "That --idempotency-key was already used for a different command.", hint: "Drop --idempotency-key, or use a new one." };
    case "RATE_LIMITED":
      return { message: "Too many writes in a minute.", hint: `Wait ${wait ?? 60}s, then retry. Update the card at phase changes, not every command.` };
    case "INVALID_DEVICE_SELECTION":
      return { message: "That phone ID is not valid.", hint: "List phones: relo devices list" };
    case "ACCOUNT_DISABLED":
      return { message: "The server admin turned off this account's access.", hint: "Retrying will not help; ask the server admin." };
    case "CREDENTIAL_REVOKED":
      return { message: "This login was revoked.", hint: "Retrying will not help. Sign in again only if the owner wants it back: relo auth login" };
    case "LOGIN_EXPIRED":
      return { message: "This login expired.", hint: "Sign in again: relo auth login" };
    case "UNAUTHORIZED":
    case "REAUTHENTICATION_REQUIRED":
    case "PRINCIPAL_CREDENTIAL_REQUIRED":
      return { message: "Relo did not accept this login.", hint: "Sign in again: relo auth login" };
    case "FORBIDDEN":
      return { message: "This login is not allowed to do that.", hint: "Sign in again to get every permission: relo auth login" };
    case "CONFIG_NOT_FOUND":
      return { message: "Not signed in to Relo.", hint: "Run: relo auth login --api-url https://YOUR-RELO-SERVER" };
    case "NETWORK_ERROR":
      return { message: `Cannot reach the Relo server (${error.message})${error.details?.retried ? "; retried once" : ""}. This is usually transient.`,
        hint: error.details?.idempotencyKey
          ? `Run the same command again with --idempotency-key ${error.details.idempotencyKey} (safe: it cannot apply twice); if it keeps failing: relo doctor`
          : "Run the same command again; if it keeps failing, check the network and RELO_API_URL: relo doctor" };
    default:
      break;
  }
  if (error instanceof TerminalInteractionError) {
    const state = error.details?.state;
    const id = error.details?.interactionId;
    if (state === "denied") return { message: "The owner denied it. Do not do it." };
    if (state === "no") return { message: "The owner said no." };
    if (state === "timeout") {
      return { message: "No answer yet; the question is still open.", hint: `relo interaction wait ${id ?? "ID"} --timeout 100s` };
    }
    return { message: `The question closed${state ? ` (${state})` : ""} with no answer. Do not act.`, hint: "Ask again only if it still matters: relo ask …" };
  }
  if (error instanceof ApiError && error.status === 404) return { message: `No such ${noun}.` };
  if (error instanceof NetworkError || error instanceof AuthError) return {};
  return {};
}

/** Small, actionable details only; the bulky server result stays behind --full. */
function compactDetails(error) {
  const details = error.details ?? {};
  const kept = present({
    state: typeof details.state === "string" ? details.state : undefined,
    id: typeof details.interactionId === "string" ? details.interactionId : undefined,
    retryAfterSeconds: details.retryAfterSeconds,
    missing: details.missing,
    // The running card or work a refused command names, so the agent can continue it.
    card: details.card && typeof details.card === "object" ? details.card : undefined,
    work: details.work && typeof details.work === "object" ? details.work : undefined,
    candidates: Array.isArray(details.candidates) ? details.candidates : undefined,
  });
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function errorLine(error, { full, group }) {
  const replaced = friendly(error, group);
  const hint = error.details?.hint ?? replaced.hint;
  const { hint: _hint, ...rest } = error.details ?? {};
  const details = full ? (Object.keys(rest).length > 0 ? rest : undefined) : compactDetails({ details: rest });
  return {
    ok: false,
    error: {
      code: error.code,
      message: replaced.message ?? error.message,
      ...(hint === undefined ? {} : { hint }),
      ...(details === undefined ? {} : { details }),
    },
  };
}

/** The same error for a person at a terminal. */
function errorText(line) {
  const { message, hint } = line.error;
  return hint ? `${message}\nhint: ${hint}` : message;
}

// Flags only count before a `--` separator; after it everything is the caller's text.
function hasFlag(argv, flag) {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes(flag);
}

/** How this run prints: --json forces JSON; piped output (agents, scripts) is structured; a terminal gets text. */
export function outputMode(argv, stdoutIsTTY) {
  const json = hasFlag(argv, "--json");
  return { json, full: hasFlag(argv, "--full"), structured: json || !stdoutIsTTY };
}

/**
 * Prints a command's outcome and returns its exit code. The contract:
 *  - --json: exactly one JSON line, whatever the outcome;
 *  - echo commands (relo work, relo state, relo admin) print their echo, piped too: the agent reads text;
 *  - help and version print plain text;
 *  - a person at a terminal gets a readable view when the command has one (relo keys status);
 *  - everything else is one compact JSON line. Piped, it carries its notices itself (nobody reads stderr);
 *    at a terminal the notices go to stderr.
 */
export function printOutcome(output, mode, { stdout, stderr }) {
  const { json, full, structured } = mode;
  if (output.command === "help" && !json) stdout(output.data.help);
  else if (output.echo !== undefined) stdout(json ? JSON.stringify(output.data) : output.echo);
  else if (output.command === "version" && !json) stdout(output.data.version);
  else if (output.text && !structured && !full) {
    stdout(output.text);
    if (output.message) stderr(output.message);
  } else {
    const notice = [output.message, ...(output.notes ?? [])].filter(Boolean).join("; ");
    // Doctor's compact line already says what is wrong in `next.why`; don't repeat it.
    const repeated = !full && structured && output.command === "doctor";
    const inline = !full && structured && notice && !repeated;
    stdout(JSON.stringify(successLine(output, { full, note: inline ? notice : undefined })));
    if (notice && !inline && !repeated) stderr(notice);
  }
  return output.exitCode;
}

/**
 * Prints a failure once and returns its exit code. A refusal (Refused / State / Next) prints its three
 * lines, piped too, unless --json. Any other error is one JSON line when structured, else text on stderr.
 */
export function printFailure(cause, mode, { stdout, stderr }, group) {
  if (cause instanceof WorkRefusal) {
    stdout(mode.json ? JSON.stringify({ ok: false, error: { code: cause.code, message: `Refused: ${cause.what}.`, state: cause.state, next: cause.next } }) : refusalText(cause));
    return cause.exitCode;
  }
  const error = normalizeError(cause);
  const line = errorLine(error, { full: mode.full, group });
  if (mode.structured) stdout(JSON.stringify(line));
  else stderr(errorText(line));
  return error.exitCode;
}
