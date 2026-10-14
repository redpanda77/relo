// What an agent reads back: one compact JSON line per command, and each error exactly once.
// `--full` prints the whole server envelope instead.
import { ApiError, AuthError, NetworkError, TerminalInteractionError } from "./errors.mjs";

const present = (fields) => Object.fromEntries(
  Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
);

/** "2/5": the step a card is on, from the steps component the server returns. */
/** Short words for `relo keys status` notices. */
const NOTICE_LABELS = { security_code_changed: "security code changed", new_phone: "waiting for approval: relo keys approve, or approve it in Relo on your trusted iPhone → Settings → Devices",
  new_phone_approved: "approved on your phone", approved_from_browser: "approved from a linked browser", browser_linked: "linked from your phone",
  phone_replaced: "phone set up again" };

export function stepPosition(activity) {
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
  // agentSetup is informational (--full only): setup is the owner's choice and never advice.
  const advice = Object.entries(data?.warnings ?? {}).filter(([name, check]) => name !== "agentSetup" && check?.ok !== true
    && !(name === "skill" && data?.next?.step === "skill"));
  return {
    ok: data?.ok === true,
    ready: data?.ready === true,
    ...(data?.next ? { next: data.next } : {}),
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

const REQUIRED_SCOPES = ["activities:read", "activities:write", "devices:read",
  "interactions:create", "interactions:read", "notifications:send"];

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
  state: session?.state,
  presence: session?.presence,
  lastEventAt: session?.lastEventAt,
  card: session?.card ? present({ state: session.card.state, quietForSeconds: session.card.quietForSeconds }) : undefined,
});

const serviceRow = (service) => present({
  id: service?.id,
  title: service?.title,
  prefix: service?.prefix,
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
      return present({ strict: data?.strict, changed: data?.changed });
    case "keys.forget":
      return present({ id: data?.deviceId, removed: data?.removed });
    case "keys.rotate":
      return present({ rotated: data?.rotated, keyId: data?.keyId, previous: data?.previous });
    case "doctor":
      return doctorFields(data);
    case "auth.status":
    case "auth.login":
      if (data?.state === "pending") return present({ state: "pending", url: data.url, code: data.code, next: data.next });
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
    case "services.create": {
      const service = data?.service ?? data;
      return present({
        id: service?.id,
        title: service?.title,
        prefix: service?.prefix,
        webhookUrl: data?.webhookUrl,
        secretFileWritten: data?.secretFileWritten === true ? true : undefined,
        secretFileName: data?.secretFileName,
      });
    }
    case "setup":
      return present({ file: data?.file, action: data?.action, from: data?.from, files: data?.files, hooks: data?.hooks, mcp: data?.mcp, skill: data?.skill,
        hint: data?.hint, dryRun: data?.dryRun === true ? true : undefined });
    case "skill.install":
    case "skill.remove":
      return present({ agent: data?.agent, dir: data?.dir, version: data?.version, action: data?.action,
        archived: data?.archived, dryRun: data?.dryRun === true ? true : undefined });
    case "skill.status":
      return { cli: data?.cli, copies: data?.copies ?? [] };
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
    case "account":
      return { ...data };
    case "update":
      return present({ ...data });
    default:
      return undefined;
  }
}

export function successLine(output, { full, note }) {
  const compact = full ? undefined : compactData(output.command, output.data);
  if (compact === undefined) return { ok: output.exitCode === 0, command: output.command, data: output.data };
  return { ok: true, ...compact, ...(note ? { note } : {}) };
}

const START_HINT = "Start a new one: relo activity start --title … --status …";

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
      return { message: `Cannot reach the Relo server (${error.message}).`, hint: "Check the network and RELO_API_URL, then run: relo doctor" };
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

export function errorLine(error, { full, group }) {
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
export function errorText(line) {
  const { message, hint } = line.error;
  return hint ? `${message}\nhint: ${hint}` : message;
}
