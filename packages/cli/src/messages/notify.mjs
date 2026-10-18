import { sealNoticeRequest, sealQuestion } from "../crypto/seal-notice.mjs";
import { rememberQuestion, verifyAnswer } from "../crypto/answer-verify.mjs";
import { assertAtMostOne, assertNoExtra, definedFields, enumOption, fitRequiredText, fitText, joinedText, optionalText, parseDuration, requireText, validateIdempotencyKey } from "../shared/validate.mjs";
import { validateCallbackUrl, validateDestinationUrl, validatePublicHttpsUrl } from "../shared/urls.mjs";
import { ApiError, TerminalInteractionError, UsageError } from "../shared/errors.mjs";
import { notificationRelevance } from "../shared/relevance.mjs";
import { activityName, validateActivityWaitResponse } from "./cards.mjs";
import { resolveTargetDevices } from "../shared/devices.mjs";
import { cardKey, creationContext, partialIdentity } from "./card-context.mjs";
import { drainDeclared } from "../work/declared-lane.mjs";
import { dryRunResult, result } from "../shared/outcome.mjs";
import { deliveryGuard } from "./delivery.mjs";
import { stdinDeviceIds, stdinObject } from "../shared/stdin.mjs";

function notificationBody(value) {
  const body = requireText(value, "Notification body", 65_536).replace(/\r\n?/gu, "\n").trim();
  if (Buffer.byteLength(body, "utf8") > 65_536) {
    throw new UsageError("Notification body must be at most 65,536 UTF-8 bytes.");
  }
  return body;
}

function notificationSummary(value, notes) {
  if (value === undefined) return undefined;
  const summary = requireText(value, "summary", 100_000).replace(/\s+/gu, " ").trim();
  return fitText(summary, "summary", 240, notes);
}

const SUCCESS_STATES = new Set(["approved", "yes", "replied", "completed"]);

const NEGATIVE_STATES = new Set(["denied", "no"]);

const CLOSED_STATES = new Set(["canceled", "cancelled", "expired", "timed_out", "timeout"]);

function bodyFormatOption(options, stdin) {
  if (options.markdown && options.format !== undefined && options.format !== "markdown") {
    throw new UsageError("--markdown cannot be combined with --format text");
  }
  return enumOption(options.markdown ? "markdown" : options.format ?? stdin.bodyFormat, "format", ["text", "markdown"]);
}

/** The token is read from a file (or stdin JSON) so it never appears in argv or shell history. */
async function callbackOption(options, stdin, dependencies) {
  const supplied = stdin.callback;
  const url = options["callback-url"] ?? supplied?.url;
  const tokenFile = options["callback-token-file"];
  if (url === undefined && tokenFile === undefined && supplied === undefined) return undefined;
  if (url === undefined) throw new UsageError("--callback-token-file requires --callback-url");
  const validatedUrl = validateCallbackUrl(url, "callback-url");
  let token = supplied?.token;
  if (tokenFile !== undefined) {
    if (token !== undefined) throw new UsageError("Use --callback-token-file or stdin callback.token, not both");
    token = (await dependencies.readTextFile(tokenFile)).trim();
  }
  if (typeof token !== "string" || token.length < 16 || token.length > 512 || /\s/.test(token)) {
    throw new UsageError("A callback needs a 16-512 character token without spaces", {
      hint: "Write the token to a file and pass --callback-token-file PATH",
    });
  }
  return { url: validatedUrl, token };
}

function askType(options, stdin) {
  const choice = (options.option?.length ?? 0) > 0 || Array.isArray(stdin.options);
  const aliases = [
    options.approval ? "approval" : undefined,
    options["yes-no"] ? "yes-no" : undefined,
    choice ? "choice" : undefined,
  ].filter(Boolean);
  if (aliases.length > 1 || (aliases.length === 1 && options.type !== undefined && options.type !== aliases[0])) {
    throw new UsageError("Use exactly one answer type: --approval, --yes-no or --option (2-4 times)");
  }
  const value = aliases[0] ?? options.type ?? stdin.type;
  if (!["approval", "yes-no", "yes_no", "choice"].includes(value)) {
    throw new UsageError("Choose the answer type: --approval (Approve/Deny), --yes-no (Yes/No) or 2-4 --option LABEL", {
      hint: 'relo ask "Deploy 0.7.57 to production?" --approval',
    });
  }
  return value === "yes-no" ? "yes_no" : value;
}

const OPTION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

/** "Roll back" → roll-back; the owner never sees ids, only labels. */
export function optionId(label) {
  return label.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32).replace(/-+$/u, "");
}

/**
 * The options of a choice question, from repeated --option LABEL (or id=LABEL) or stdin
 * "options": ["Ship", …] / [{"id","label"}, …]. 2-4 options, unique ids and labels.
 */
function choiceOptions(options, stdin) {
  const raw = options.option?.length ? options.option : stdin.options;
  const parsed = (raw ?? []).map((entry) => {
    if (entry && typeof entry === "object") return { id: String(entry.id ?? ""), label: String(entry.label ?? "").trim() };
    const text = String(entry);
    const split = /^([a-z0-9][a-z0-9_-]{0,31})=(.+)$/u.exec(text);
    const label = (split ? split[2] : text).trim();
    return { id: split ? split[1] : optionId(label), label };
  });
  if (parsed.length < 2 || parsed.length > 4) {
    throw new UsageError(`A choice offers 2-4 options (got ${parsed.length})`, {
      hint: 'relo ask "Which release?" --option Ship --option Wait --option "Roll back"',
    });
  }
  for (const option of parsed) {
    if (!option.label || Array.from(option.label).length > 24 || /[\r\n]/u.test(option.label)) {
      throw new UsageError(`Option "${option.label}" must be one line of 1-24 characters`);
    }
    if (!OPTION_ID.test(option.id)) {
      throw new UsageError(`Option "${option.label}" needs an id of lowercase letters, digits, - or _`, {
        hint: "Write it as --option id=Label, for example --option v2=Version 2",
      });
    }
  }
  if (new Set(parsed.map((option) => option.id)).size !== parsed.length
    || new Set(parsed.map((option) => option.label.toLowerCase())).size !== parsed.length) {
    throw new UsageError("Options need different labels and ids");
  }
  return parsed;
}

/**
 * The fallback when no card can reach the phone: a question answered in Relo, announced by a
 * notification that carries no answer buttons.
 */
async function askInApp({ prompt, detail, choices, type, expiresInSeconds, wait, timeoutSeconds, options, stdin, client, dependencies,
  command, idempotencyKey, context, title, buttons = false, reason }) {
  const identity = context ?? creationContext(options, stdin, undefined, dependencies.creationDefaults(), ASK_EXAMPLE);
  const askedAt = new Date(dependencies.now());
  const questionTitle = requireText(title ?? identity.taskTitle ?? identity.threadName, "Title", 80);
  const deviceIds = await resolveTargetDevices(client, options.device.length > 0 ? options.device : []);
  // Sealed end to end for this computer's verified phones (E4.1).
  const sealedQuestion = await sealQuestion({ title: questionTitle, prompt, detail, key: `${idempotencyKey}:in-app`, client,
    config: { apiUrl: client.apiUrl }, dependencies, notes: [], deviceIds, context: identity });
  const sealed = sealedQuestion?.sealed;
  const created = deliveryGuard(await client.createInteraction(definedFields({
    ...(sealed ? { sealed } : { prompt, detail, title: questionTitle }), options: choices, type, expiresInSeconds,
    answerInApp: buttons ? undefined : true, context: sealedQuestion?.context ?? identity,
    correlationId: optionalText(options["correlation-id"] ?? stdin.correlationId, "Correlation ID", 100),
    callback: await callbackOption(options, stdin, dependencies),
    deviceIds: sealed ? undefined : deviceIds,
  }), `${idempotencyKey}:in-app`,
  dependencies.messages.sessionKey(dependencies)));
  // With buttons the owner answers right on the notification; without, the phone has no card and opens Relo.
  const message = reason ?? (buttons ? undefined
    : "This phone cannot show Live Activities, so the owner answers in Relo from a notification.");
  const data = { ...created, card: null, fallback: buttons ? "notification" : "answer_in_app" };
  const id = created?.interaction?.id;
  // Remembered even without waiting, so `relo interaction wait` later checks the question-bound signature.
  if (sealed && id) await rememberQuestion(dependencies, { interactionId: id, questionContext: sealed.content.context, askedAt: askedAt.toISOString() });
  if (!wait) return result(command, data, { message });
  if (!id) throw new ApiError("Interaction response did not include an ID.", { code: "INVALID_API_RESPONSE" });
  try {
    const waited = await waitForInteraction(client, id, timeoutSeconds, dependencies);
    return result(command, mergeCreatedAndWaitedInteraction(data, waited), { message });
  } catch (error) {
    if (!(error instanceof TerminalInteractionError)) throw error;
    const { state, result: waitedResult, ...details } = error.details ?? {};
    throw new TerminalInteractionError(error.message, {
      state, details: { ...details, result: mergeCreatedAndWaitedInteraction(data, waitedResult) },
    });
  }
}

/** A question waits for the owner at most five minutes; unanswered, it expires and its card ends. */
export const QUESTION_SECONDS = 300;

/**
 * A question is one line the owner answers from the Lock Screen (the card shows 120 characters).
 * The why, the risk and what changes go in --detail: markdown, read in Relo.
 */
export const QUESTION_MAX_CHARACTERS = 120;
const QUESTION_DETAIL_MAX_CHARACTERS = 4_000;

function questionText(value) {
  const text = requireText(value, "Question", 2_000);
  if (Array.from(text).length > QUESTION_MAX_CHARACTERS || /[\r\n]/u.test(text)) {
    throw new UsageError(`A question is one line of at most ${QUESTION_MAX_CHARACTERS} characters (this one has ${Array.from(text).length})`, {
      hint: 'Ask the decision in one line and put the why, the risk and what changes in --detail "..." (markdown, up to 4,000 characters)',
    });
  }
  return text;
}

const ASK_EXAMPLE = 'relo ask "Deploy?" --approval';

/** How long a command waits for an answer by default, as the caller's type says (an agent's shell: 100 s). */
export const messageWaitSeconds = (dependencies) => dependencies.messages.waitSeconds(dependencies);

/** The longest any server lets a question wait; each server's admin sets a lower limit (default 7 days). */
const QUESTION_CEILING_SECONDS = 30 * 86_400;

function questionSeconds(value, flag, { defaultSeconds, minimumSeconds, maximumSeconds = QUESTION_CEILING_SECONDS }) {
  try {
    return parseDuration(value, { defaultSeconds, minimumSeconds, maximumSeconds });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    throw new UsageError(flag === "--timeout"
      ? `--timeout must be between ${minimumSeconds}s and the question's --expires-in`
      : `--expires-in must be between ${minimumSeconds}s and 30d (the server's own limit may be lower)`, {
      hint: flag === "--timeout" ? "Wait less, then resume with relo interaction wait ID" : "Use for example --expires-in 2h or 1d",
    });
  }
}

/** `relo ask PROMPT --approval|--yes-no`: parses the question, then asks on this work's card. */
async function askCommand(words, options, client, config, dependencies, command) {
  if (options.timeout !== undefined && options["no-wait"]) throw new UsageError("--timeout cannot be combined with --no-wait");
  const stdin = await stdinObject(options, dependencies);
  const type = askType(options, stdin);
  const prompt = questionText(joinedText(words) ?? stdin.prompt);
  const choices = type === "choice" ? choiceOptions(options, stdin) : undefined;
  if (choices && (options["primary-label"] !== undefined || options["secondary-label"] !== undefined)) {
    throw new UsageError("A choice labels its options; --primary-label and --secondary-label are for --approval/--yes-no");
  }
  const detail = optionalText(options.detail ?? stdin.detail, "Detail", QUESTION_DETAIL_MAX_CHARACTERS);
  const expiresInSeconds = questionSeconds(options["expires-in"] ?? stdin.expiresInSeconds, "--expires-in",
    { defaultSeconds: QUESTION_SECONDS, minimumSeconds: 30 });
  const wait = !options["no-wait"];
  // Blocks for the question's life up to 5 minutes (100s in an agent session); a longer question stays
  // open after that: `relo interaction wait ID` resumes it.
  const timeoutSeconds = wait
    ? questionSeconds(options.timeout, "--timeout", {
      defaultSeconds: Math.min(expiresInSeconds, messageWaitSeconds(dependencies) ?? QUESTION_SECONDS),
      minimumSeconds: 1, maximumSeconds: expiresInSeconds })
    : undefined;
  const labels = { primary: options["primary-label"] ?? stdin.primaryLabel, secondary: options["secondary-label"] ?? stdin.secondaryLabel };
  // Checked before anything is sent, wherever the question ends up (a card or a notification).
  actionLabel(labels.primary, "primary-label");
  actionLabel(labels.secondary, "secondary-label");
  return askOnCard({ prompt, detail, choices, type, expiresInSeconds, wait, timeoutSeconds, options, stdin,
    client, config, dependencies, command, labels });
}

/**
 * Asks on this work's card: the question appears on the card with answer buttons, and the card
 * returns to the work once answered. A question never starts a card (ADR 0007): with no card
 * running for this work it goes out as a notification that carries the answer buttons.
 */
async function askOnCard({ prompt, detail, choices, type, labels, expiresInSeconds, wait, timeoutSeconds,
  options, stdin, client, config, dependencies, command }) {
  if (dependencies.dryRun) {
    return dryAsk({ prompt, detail, choices, type, labels, expiresInSeconds, wait, timeoutSeconds, options, stdin, dependencies });
  }
  const defaults = await dependencies.messages.defaults(dependencies, dependencies.creationDefaults());
  const idempotencyKey = validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey);
  // Queued work changes go first (EDGE.3): the question lands on the work as it now is. A question is
  // never queued itself: an approval needs the server now.
  await drainDeclared({ client, config, dependencies });
  const named = activityName(options, stdin);
  // An app that should not take a card asks with a notification that carries the answer buttons.
  if (options["notification-only"]) {
    return askInApp({ prompt, detail, choices, type, expiresInSeconds, wait, timeoutSeconds, options, stdin, client, dependencies,
      command, idempotencyKey, buttons: true, context: creationContext(options, stdin, undefined, defaults, ASK_EXAMPLE) });
  }
  // Outside an agent session the identity names the card, so validate it before any request.
  const known = named === undefined && !dependencies.messages.cardOwner(dependencies)
    ? creationContext(options, stdin, undefined, defaults, ASK_EXAMPLE) : undefined;
  const card = await workCard(options, stdin, client, dependencies, known ?? partialIdentity(options, stdin, defaults));
  if (!card) {
    return askInApp({ prompt, detail, choices, type, expiresInSeconds, wait, timeoutSeconds, options, stdin, client, dependencies,
      command, idempotencyKey, buttons: true, context: known ?? creationContext(options, stdin, undefined, defaults, ASK_EXAMPLE),
      reason: "No card is running for this work, so the question went out as a notification with answer buttons." });
  }
  const callback = await callbackOption(options, stdin, dependencies);
  const notes = [];
  // Sealed end to end for this computer's verified phones (E4.1); the card shows a placeholder.
  const askedAt = new Date(dependencies.now());
  const sealed = (await sealQuestion({ title: card.title, prompt, detail, key: idempotencyKey, client, config, dependencies, notes }))?.sealed;
  let createdRaw;
  try {
    createdRaw = await client.createActivityWait(card.id, definedFields({
      type, ...(sealed ? { sealed } : { prompt, detail }), options: choices, expiresInSeconds,
      primaryLabel: actionLabel(labels.primary, "primary-label"),
      secondaryLabel: actionLabel(labels.secondary, "secondary-label"),
      correlationId: optionalText(options["correlation-id"] ?? stdin.correlationId, "Correlation ID", 100),
      callback,
    }), idempotencyKey);
  } catch (error) {
    if (error?.code !== "ACTIVITY_TARGET_UNAVAILABLE") throw error;
    return askInApp({ prompt, detail, choices, type, expiresInSeconds, wait, timeoutSeconds, options, stdin, client, dependencies,
      // A work card names no source/topic itself: inside a session the session's defaults name it.
      command, idempotencyKey, title: card.title, context: known ?? cardIdentity(card) ?? creationContext(options, stdin, undefined, defaults, ASK_EXAMPLE) });
  }
  const created = validateActivityWaitResponse(createdRaw, { parentActivityId: card.id, type, prompt: sealed ? undefined : prompt });
  if (sealed) await rememberQuestion(dependencies, { interactionId: created.interaction.id,
    questionContext: sealed.content.context, askedAt: askedAt.toISOString() });
  const data = { ...created, card: { id: card.id }, endToEnd: Boolean(sealed) };
  if (!wait) return result(command, data, { notes });
  // The card belongs to the work: answering never ends it.
  try {
    const waited = await waitForInteraction(client, created.interaction.id, timeoutSeconds, dependencies);
    return result(command, mergeCreatedAndWaitedInteraction(data, waited), { notes });
  } catch (error) {
    if (!(error instanceof TerminalInteractionError)) throw error;
    const { state, result: waitedResult, ...details } = error.details ?? {};
    throw new TerminalInteractionError(error.message, {
      state, details: { ...details, result: mergeCreatedAndWaitedInteraction(data, waitedResult) },
    });
  }
}

/** A running card's source, project and topic, when it carries all three. */
function cardIdentity(card) {
  const context = card?.context;
  return context?.providerName && context?.project && context?.threadName ? context : undefined;
}

/** The running card of this work, or null. Only reads: a question never creates or changes a card. */
async function workCard(options, stdin, client, dependencies, context) {
  const key = cardKey({ name: activityName(options, stdin), env: dependencies.env, owner: dependencies.messages.cardOwner(dependencies), context });
  return dependencies.messages.card(client, dependencies, { key });
}

/** `relo ask --dry-run`: every local check of the real ask, then what it would send. No request. */
async function dryAsk({ prompt, detail, choices, type, labels, expiresInSeconds, wait, timeoutSeconds, options, stdin, dependencies }) {
  const notes = [];
  validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey);
  const defaults = await dependencies.messages.defaults(dependencies, dependencies.creationDefaults());
  const named = activityName(options, stdin);
  let context;
  try {
    context = creationContext(options, stdin, undefined, defaults, ASK_EXAMPLE);
  } catch (error) {
    // With a card name or an agent session the identity may come from the running card.
    if (!(error instanceof UsageError) || (named === undefined && !dependencies.messages.cardOwner(dependencies))) throw error;
    notes.push("source, project and topic are read from the session's card when it is running; starting one needs them");
  }
  const key = cardKey({ name: named, env: dependencies.env, owner: dependencies.messages.cardOwner(dependencies), context: context ?? partialIdentity(options, stdin, defaults) });
  const callback = await callbackOption(options, stdin, dependencies);
  if (options.device.length > 0) notes.push("device IDs are not checked against the server in a dry run");
  return dryRunResult("ask", definedFields({
    type, prompt, detail, options: choices, expiresInSeconds, wait,
    ...(wait ? { timeoutSeconds } : {}),
    primaryLabel: actionLabel(labels.primary, "primary-label"),
    secondaryLabel: actionLabel(labels.secondary, "secondary-label"),
    correlationId: optionalText(options["correlation-id"] ?? stdin.correlationId, "Correlation ID", 100),
    callback: callback ? { url: callback.url } : undefined,
    card: key,
    ...(context ? { context } : {}),
    deviceIds: await resolveTargetDevices(undefined, options.device, { verify: false }),
  }), notes);
}

function actionLabel(value, name) {
  if (value === undefined) return undefined;
  const label = requireText(value, name, 24);
  if (/\r|\n/u.test(label)) {
    throw new UsageError(`${name} must be a single line of 1 to 24 characters`);
  }
  return label;
}

export function interactionState(payload) {
  const interaction = payload?.interaction ?? payload;
  return interaction?.state ?? interaction?.status;
}

function interactionResult(payload) {
  const interaction = payload?.interaction ?? payload;
  const state = interactionState(payload);
  if (SUCCESS_STATES.has(state)) return payload;
  if (NEGATIVE_STATES.has(state) || CLOSED_STATES.has(state)) {
    // A server-closed question is never the CLI's own "timeout" (the question is still open).
    const closedState = state === "timeout" ? "timed_out" : state;
    throw new TerminalInteractionError(`Interaction ended with state: ${closedState}`, {
      state: closedState,
      details: {
        interactionId: interaction?.id,
        result: payload?.interaction === undefined ? { interaction } : payload,
      },
    });
  }
  throw new TerminalInteractionError("Interaction wait ended without a terminal response.", {
    state: "timeout",
    details: {
      interactionId: interaction?.id,
      result: payload?.interaction === undefined ? { interaction } : payload,
    },
  });
}

/** Cloudflare cuts a request at about 100 s (HTTP 524), so a long wait is a loop of slices under it. */
export const WAIT_SLICE_SECONDS = 90;
const EDGE_TIMEOUT_STATUSES = new Set([502, 504, 524]);

export async function waitForInteraction(client, id, timeoutSeconds, dependencies, expected = {}) {
  const deadline = dependencies.now() + timeoutSeconds * 1_000;
  let latest = { interaction: { id, state: "pending" } };
  while (dependencies.now() < deadline) {
    const startedAt = dependencies.now();
    const remainingSeconds = Math.max(1, Math.ceil((deadline - startedAt) / 1_000));
    const pollSeconds = Math.min(WAIT_SLICE_SECONDS, remainingSeconds);
    try {
      latest = await client.waitForInteraction(id, pollSeconds);
    } catch (error) {
      // The edge cut this slice: the question is still open, so the next slice picks up where it ended.
      if (!(error instanceof ApiError && EDGE_TIMEOUT_STATUSES.has(error.status))) throw error;
      await dependencies.sleep(Math.min(1_000, Math.max(0, deadline - dependencies.now())));
      continue;
    }
    // A positive answer is acted on only when a phone this computer verified signed it (E4.2).
    if (interactionState(latest) !== "pending") {
      return verifyAnswer(interactionResult(latest), client, dependencies, { interactionId: id, ...expected });
    }
    if (dependencies.now() >= deadline) break;
    const elapsedMilliseconds = Math.max(0, dependencies.now() - startedAt);
    if (elapsedMilliseconds < pollSeconds * 1_000) {
      await dependencies.sleep(
        Math.min(250, pollSeconds * 1_000 - elapsedMilliseconds, deadline - dependencies.now()),
      );
    }
  }
  return verifyAnswer(interactionResult(latest), client, dependencies, { interactionId: id, ...expected });
}

function mergeCreatedAndWaitedInteraction(created, waited) {
  const canonicalInteraction = waited?.interaction ?? waited;
  return {
    ...(waited?.interaction === undefined ? {} : waited),
    ...created,
    interaction: canonicalInteraction,
  };
}

const partialIdentityContext = (options, stdin, defaults) => {
  const known = partialIdentity(options, stdin, defaults);
  return { providerName: known.providerName, project: known.project, threadName: known.threadName };
};

/** Runs this group's commands; returns undefined when the command is not one of them. */
export async function runNotifyCommand(command) {
  const { options, group, action, rest, dependencies, config, client } = command;
  if (group === "notify" && action === "send") {
    const stdin = await stdinObject(options, dependencies);
    const notes = [];
    const dryRun = Boolean(dependencies.dryRun);
    // The body comes first: with nothing to send, the identity is not the problem to report.
    const noticeBody = notificationBody(joinedText(rest) ?? stdin.body);
    const baseDefaults = dryRun ? await dependencies.messages.defaults(dependencies, dependencies.creationDefaults())
      : await dependencies.messages.noticeDefaults(client, dependencies, { options, stdin, base: dependencies.creationDefaults() });
    let context;
    try {
      context = creationContext(options, stdin, undefined, baseDefaults, 'relo notify "Done"');
    } catch (error) {
      if (!dryRun || !(error instanceof UsageError) || !dependencies.messages.cardOwner(dependencies)) throw error;
      notes.push("source, project and topic are read from the session's card when it is running");
      context = definedFields({ ...baseDefaults, ...partialIdentityContext(options, stdin, baseDefaults) });
    }
    const deviceIds = await resolveTargetDevices(
      client,
      options.device.length > 0 ? options.device : stdinDeviceIds(stdin.deviceIds),
      { verify: !dryRun },
    );
    const body = definedFields({
      body: noticeBody,
      summary: notificationSummary(options.summary ?? stdin.summary, notes),
      bodyFormat: bodyFormatOption(options, stdin),
      title: fitRequiredText(options.title ?? stdin.title ?? context.providerName, "Title", 80, notes),
      sourceName: context.providerName,
      imageUrl: validatePublicHttpsUrl(options.image ?? stdin.imageUrl, "image"),
      destinationUrl: validateDestinationUrl(
        options.url ?? stdin.destinationUrl ?? stdin.url,
        "url",
      ),
      deviceIds,
      ...(Object.values(context).some((value) => value !== undefined) ? { context } : {}),
      relevance: notificationRelevance(stdin.relevance,"notice"),
    });
    const key=validateIdempotencyKey(options["idempotency-key"],dependencies.generateIdempotencyKey);
    if (dryRun) {
      if (deviceIds) notes.push("device IDs are not checked against the server in a dry run");
      return dryRunResult("notify send", body, notes);
    }
    const capturedBody=await dependencies.prepareNotificationCommand({config,key,body,kind:"notice",
      occurredAt:dependencies.commandOccurredAt},{root:dependencies.activityCaptureDirectory,environment:dependencies.env,home:dependencies.home});
    // Queued work changes go first (EDGE.3), so the notice never overtakes them.
    await drainDeclared({ client, config, dependencies });
    // Sealed end to end for the phones this computer verified (relo keys verify); plain otherwise.
    const outgoing = await sealNoticeRequest({ body: capturedBody, key, client, config, dependencies, notes });
    const data = deliveryGuard(
      await client.sendNotification(
        outgoing,key,dependencies.messages.sessionKey(dependencies),
      ),
    );
    return result("notify.send", { ...data, endToEnd: Boolean(outgoing.sealed) }, { notes });
  }

  if (group === "notify" && action === "withdraw") {
    assertAtMostOne(rest, "Usage: relo notify withdraw ID [--idempotency-key KEY]");
    const id = requireText(rest[0], "Notification ID", 100);
    const data = await client.withdrawNotification(
      id,
      validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey),
    );
    return result("notify.withdraw", data);
  }

  if (group === "ask") {
    return askCommand([action, ...rest].filter((value) => value !== undefined), options, client, config, dependencies, "ask");
  }

  if (group === "interaction" && action === "get") {
    assertNoExtra(rest, 1, "Usage: relo interaction get ID");
    const data = await client.getInteraction(rest[0]);
    return result(
      "interaction.get",
      interactionState(data) === "pending" ? data : interactionResult(data),
    );
  }

  if (group === "interaction" && action === "wait") {
    assertNoExtra(rest, 1, "Usage: relo interaction wait ID [--timeout 100s]");
    const timeoutSeconds = parseDuration(options.timeout, {
      defaultSeconds: messageWaitSeconds(dependencies) ?? 60, maximumSeconds: 3_600 });
    return result(
      "interaction.wait",
      await waitForInteraction(client, rest[0], timeoutSeconds, dependencies),
    );
  }

  if (group === "interaction" && action === "cancel") {
    assertNoExtra(rest, 1, "Usage: relo interaction cancel ID");
    return result("interaction.cancel", await client.cancelInteraction(rest[0]));
  }
  return undefined;
}
