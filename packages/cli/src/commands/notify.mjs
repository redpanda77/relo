import { parseDuration, requireText, validateDestinationUrl, validatePublicHttpsUrl } from "../args.mjs";
import { ApiError, TerminalInteractionError, UsageError } from "../errors.mjs";
import { notificationRelevance } from "../relevance.mjs";
import { DEFAULT_ACTIVITY_EXPIRES_SECONDS, DEFAULT_ACTIVITY_STALE_SECONDS, activeCard, activityName, validateActivityWaitResponse } from "./activity.mjs";
import { resolveTargetDevices } from "./admin.mjs";
import { agentSession, cardKey, creationContext, partialIdentity } from "../identity.mjs";
import { assertAllowedOptions, assertAtMostOne, assertNoExtra, definedFields, deliveryGuard, enumOption, joinedText, optionalText, result, stdinDeviceIds, stdinObject, validateIdempotencyKey } from "../support.mjs";

export function notificationBody(value) {
  const body = requireText(value, "Notification body", 65_536).replace(/\r\n?/gu, "\n").trim();
  if (Buffer.byteLength(body, "utf8") > 65_536) {
    throw new UsageError("Notification body must be at most 65,536 UTF-8 bytes.");
  }
  return body;
}

export function notificationSummary(value) {
  if (value === undefined) return undefined;
  const summary = requireText(value, "summary", 960).replace(/\s+/gu, " ").trim();
  if (Array.from(summary).length > 240) {
    throw new UsageError("Notification summary must be at most 240 characters.");
  }
  return summary;
}

export const SUCCESS_STATES = new Set(["approved", "yes", "replied", "completed"]);

export const NEGATIVE_STATES = new Set(["denied", "no"]);

export const CLOSED_STATES = new Set(["canceled", "cancelled", "expired", "timed_out", "timeout"]);

export function bodyFormatOption(options, stdin) {
  if (options.markdown && options.format !== undefined && options.format !== "markdown") {
    throw new UsageError("--markdown cannot be combined with --format text");
  }
  return enumOption(options.markdown ? "markdown" : options.format ?? stdin.bodyFormat, "format", ["text", "markdown"]);
}

export function privacyOption(options, stdin) {
  const value = options.privacy ?? options["privacy-mode"] ?? stdin.privacy ?? stdin.privacyMode;
  return value === undefined ? undefined : enumOption(value, "privacy", ["standard", "private"]);
}

/** The token is read from a file (or stdin JSON) so it never appears in argv or shell history. */
export async function callbackOption(options, stdin, dependencies) {
  const supplied = stdin.callback;
  const url = options["callback-url"] ?? supplied?.url;
  const tokenFile = options["callback-token-file"];
  if (url === undefined && tokenFile === undefined && supplied === undefined) return undefined;
  if (url === undefined) throw new UsageError("--callback-token-file requires --callback-url");
  const validatedUrl = validatePublicHttpsUrl(url, "callback-url");
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

export function askType(options, stdin) {
  const aliases = [
    options.approval ? "approval" : undefined,
    options["yes-no"] ? "yes-no" : undefined,
  ].filter(Boolean);
  if (aliases.length > 1 || (aliases.length === 1 && options.type !== undefined)) {
    throw new UsageError("Use exactly one answer type: --approval or --yes-no");
  }
  const value = aliases[0] ?? options.type ?? stdin.type;
  if (!["approval", "yes-no", "yes_no"].includes(value)) {
    throw new UsageError("Choose the answer type: --approval (Approve/Deny) or --yes-no (Yes/No)", {
      hint: 'relo ask "Deploy 0.7.57 to production?" --approval',
    });
  }
  return value === "yes-no" ? "yes_no" : value;
}

export const ANSWER_LABELS = { approved: "Approved", denied: "Denied", yes: "Yes", no: "No",
  expired: "No answer", canceled: "Canceled", timed_out: "No answer" };

/**
 * The fallback when no card can reach the phone: a question answered in Relo, announced by a
 * notification that carries no answer buttons.
 */
export async function askInApp({ prompt, type, expiresInSeconds, wait, timeoutSeconds, options, stdin, client, dependencies,
  command, idempotencyKey, context, title }) {
  const identity = context ?? creationContext(options, stdin, undefined, dependencies.identityDefaults());
  const created = deliveryGuard(await client.createInteraction(definedFields({
    prompt, type, expiresInSeconds, answerInApp: true, context: identity,
    title: requireText(title ?? identity.taskTitle ?? identity.threadName, "Title", 80),
    correlationId: optionalText(options["correlation-id"] ?? stdin.correlationId, "Correlation ID", 100),
    callback: await callbackOption(options, stdin, dependencies),
    deviceIds: await resolveTargetDevices(client, options.device.length > 0 ? options.device : []),
  }), `${idempotencyKey}:in-app`));
  const message = "This phone cannot show Live Activities, so the owner answers in Relo from a notification.";
  const data = { ...created, card: null, fallback: "answer_in_app" };
  if (!wait) return result(command, data, { message });
  const id = created?.interaction?.id;
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

export function questionSeconds(value, flag, { defaultSeconds, minimumSeconds }) {
  try {
    return parseDuration(value, { defaultSeconds, minimumSeconds, maximumSeconds: QUESTION_SECONDS });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    throw new UsageError(`${flag} must be between ${minimumSeconds}s and 5m: a question waits at most 5 minutes`, {
      hint: `Use ${flag} 5m or less`,
    });
  }
}

/** `relo ask PROMPT --approval|--yes-no`: parses the question, then asks on this work's card. */
export async function askCommand(words, options, client, config, dependencies, command) {
  if (options.timeout !== undefined && options["no-wait"]) throw new UsageError("--timeout cannot be combined with --no-wait");
  const stdin = await stdinObject(options, dependencies);
  const type = askType(options, stdin);
  const prompt = requireText(joinedText(words) ?? stdin.prompt, "Question", 240);
  const expiresInSeconds = questionSeconds(options["expires-in"] ?? stdin.expiresInSeconds, "--expires-in",
    { defaultSeconds: QUESTION_SECONDS, minimumSeconds: 30 });
  const wait = !options["no-wait"];
  const timeoutSeconds = wait
    ? questionSeconds(options.timeout, "--timeout", { defaultSeconds: expiresInSeconds, minimumSeconds: 1 })
    : undefined;
  return askOnCard({ prompt, type, expiresInSeconds, wait, timeoutSeconds, options, stdin,
    client, config, dependencies, command,
    labels: { primary: options["primary-label"] ?? stdin.primaryLabel, secondary: options["secondary-label"] ?? stdin.secondaryLabel } });
}

/**
 * Asks on this work's card: the question appears on the card with answer buttons, and the
 * card returns to the work once answered. No card yet? Ask starts one for the question.
 */
export async function askOnCard({ prompt, type, labels, expiresInSeconds, wait, timeoutSeconds,
  options, stdin, client, config, dependencies, command }) {
  const defaults = dependencies.identityDefaults();
  const idempotencyKey = validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey);
  let createdByAsk = false;
  const named = activityName(options, stdin);
  // Outside an agent session the identity names the card, so validate it before any request.
  const known = named === undefined && !agentSession(dependencies.env)
    ? creationContext(options, stdin, undefined, defaults) : undefined;
  const key = cardKey({ name: named, env: dependencies.env, context: known ?? partialIdentity(options, stdin, defaults) });
  let card = key === undefined ? null : await activeCard(client, key);
  if (!card) {
    const context = known ?? creationContext(options, stdin, undefined, defaults);
    const started = await client.startActivity(definedFields({
      key: key ?? cardKey({ env: {}, context }),
      acquireMode: "ensure",
      title: requireText(context.taskTitle ?? context.threadName, "Card title", 80),
      status: "Needs you",
      context,
      expiresInSeconds: Math.min(28_800, Math.max(DEFAULT_ACTIVITY_EXPIRES_SECONDS, expiresInSeconds + 300)),
      staleAfterSeconds: DEFAULT_ACTIVITY_STALE_SECONDS,
      deviceIds: await resolveTargetDevices(client, options.device.length > 0 ? options.device : []),
    }), `${idempotencyKey}:card`);
    card = started?.activity;
    createdByAsk = true;
    if (!started?.delivery?.durableCommands) {
      // No phone can show a card (Live Activities off): don't leave an empty card behind.
      if (card?.id) {
        await client.endActivity(card.id, { status: "Ended", dismissAfterSeconds: 0 }, `${idempotencyKey}:void`).catch(() => {});
      }
      return askInApp({ prompt, type, expiresInSeconds, wait, timeoutSeconds, options, stdin, client, dependencies,
        command, idempotencyKey, context });
    }
  }
  const callback = await callbackOption(options, stdin, dependencies);
  let createdRaw;
  try {
    createdRaw = await client.createActivityWait(card.id, definedFields({
      type, prompt, expiresInSeconds,
      primaryLabel: actionLabel(labels.primary, "primary-label"),
      secondaryLabel: actionLabel(labels.secondary, "secondary-label"),
      correlationId: optionalText(options["correlation-id"] ?? stdin.correlationId, "Correlation ID", 100),
      callback,
    }), idempotencyKey);
  } catch (error) {
    if (error?.code !== "ACTIVITY_TARGET_UNAVAILABLE") throw error;
    return askInApp({ prompt, type, expiresInSeconds, wait, timeoutSeconds, options, stdin, client, dependencies,
      command, idempotencyKey, title: card.title });
  }
  const created = validateActivityWaitResponse(createdRaw, { parentActivityId: card.id, type, prompt });
  const data = { ...created, card: { id: card.id, createdForQuestion: createdByAsk } };
  if (!wait) return result(command, data);
  // A card started only for this question ends once answered, unless an agent session keeps
  // using it as its live view.
  const settle = async (state) => {
    if (!createdByAsk || agentSession(dependencies.env)) return;
    await client.endActivity(card.id, { status: ANSWER_LABELS[state] ?? "Answered",
      symbol: state === "approved" || state === "yes" ? "success" : "warning", dismissAfterSeconds: 60 },
    `${idempotencyKey}:end`).catch(() => {});
  };
  try {
    const waited = await waitForInteraction(client, created.interaction.id, timeoutSeconds, dependencies);
    await settle(waited?.interaction?.state ?? waited?.state);
    return result(command, mergeCreatedAndWaitedInteraction(data, waited));
  } catch (error) {
    if (!(error instanceof TerminalInteractionError)) throw error;
    const { state, result: waitedResult, ...details } = error.details ?? {};
    if (state !== "timeout") await settle(state);
    throw new TerminalInteractionError(error.message, {
      state, details: { ...details, result: mergeCreatedAndWaitedInteraction(data, waitedResult) },
    });
  }
}

export function actionLabel(value, name) {
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

export function interactionResult(payload) {
  const interaction = payload?.interaction ?? payload;
  const state = interactionState(payload);
  if (SUCCESS_STATES.has(state)) return payload;
  if (NEGATIVE_STATES.has(state) || CLOSED_STATES.has(state)) {
    throw new TerminalInteractionError(`Interaction ended with state: ${state}`, {
      state,
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

export async function waitForInteraction(client, id, timeoutSeconds, dependencies) {
  const deadline = dependencies.now() + timeoutSeconds * 1_000;
  let latest = { interaction: { id, state: "pending" } };
  while (dependencies.now() < deadline) {
    const startedAt = dependencies.now();
    const remainingSeconds = Math.max(1, Math.ceil((deadline - startedAt) / 1_000));
    const pollSeconds = Math.min(300, remainingSeconds);
    latest = await client.waitForInteraction(id, pollSeconds);
    if (interactionState(latest) !== "pending") return interactionResult(latest);
    if (dependencies.now() >= deadline) break;
    const elapsedMilliseconds = Math.max(0, dependencies.now() - startedAt);
    if (elapsedMilliseconds < pollSeconds * 1_000) {
      await dependencies.sleep(
        Math.min(250, pollSeconds * 1_000 - elapsedMilliseconds, deadline - dependencies.now()),
      );
    }
  }
  return interactionResult(latest);
}

export function mergeCreatedAndWaitedInteraction(created, waited) {
  const canonicalInteraction = waited?.interaction ?? waited;
  return {
    ...(waited?.interaction === undefined ? {} : waited),
    ...created,
    interaction: canonicalInteraction,
  };
}

/** Runs this group's commands; returns undefined when the command is not one of them. */
export async function runNotifyCommand(command) {
  const { options, group, action, rest, dependencies, config, client } = command;
  if (group === "notify" && action === "send") {
    assertAllowedOptions(options, [
      "title",
      "summary",
      "format",
      "markdown",
      "image",
      "url",
      "device",
      "idempotency-key",
      "computer",
      "source",
      "topic",
      "project",
      "thread-name",
      "task-title",
      "stdin",
    ]);
    const stdin = await stdinObject(options, dependencies);
    const context = creationContext(options, stdin, undefined, dependencies.identityDefaults());
    const deviceIds = await resolveTargetDevices(
      client,
      options.device.length > 0 ? options.device : stdinDeviceIds(stdin.deviceIds),
    );
    const body = definedFields({
      body: notificationBody(joinedText(rest) ?? stdin.body),
      summary: notificationSummary(options.summary ?? stdin.summary),
      bodyFormat: bodyFormatOption(options, stdin),
      title: requireText(options.title ?? stdin.title ?? context.providerName, "Title", 80),
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
    const capturedBody=await dependencies.prepareNotificationCommand({config,key,body,kind:"notice",
      occurredAt:dependencies.commandOccurredAt},{root:dependencies.activityCaptureDirectory,environment:dependencies.env});
    const data = deliveryGuard(
      await client.sendNotification(
        capturedBody,key,
      ),
    );
    return result("notify.send", data);
  }

  if (group === "notify" && action === "withdraw") {
    assertAtMostOne(rest, "Usage: relo notify withdraw ID [--idempotency-key KEY]");
    assertAllowedOptions(options, ["idempotency-key"]);
    const id = requireText(rest[0], "Notification ID", 100);
    const data = await client.withdrawNotification(
      id,
      validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey),
    );
    return result("notify.withdraw", data);
  }

  if (group === "ask") {
    assertAllowedOptions(options, ["type","approval","yes-no","expires-in","timeout","no-wait","primary-label","secondary-label",
      "device","idempotency-key","stdin","name","source","project","topic","thread-name","task-title","computer",
      "correlation-id","callback-url","callback-token-file"]);
    return askCommand([action, ...rest].filter((value) => value !== undefined), options, client, config, dependencies, "ask");
  }

  if (group === "interaction" && action === "get") {
    assertNoExtra(rest, 1, "Usage: relo interaction get ID");
    assertAllowedOptions(options, []);
    const data = await client.getInteraction(rest[0]);
    return result(
      "interaction.get",
      interactionState(data) === "pending" ? data : interactionResult(data),
    );
  }

  if (group === "interaction" && action === "wait") {
    assertNoExtra(rest, 1, "Usage: relo interaction wait ID [--timeout 60s]");
    assertAllowedOptions(options, ["timeout"]);
    const timeoutSeconds = parseDuration(options.timeout, { defaultSeconds: 60, maximumSeconds: 3_600 });
    return result(
      "interaction.wait",
      await waitForInteraction(client, rest[0], timeoutSeconds, dependencies),
    );
  }

  if (group === "interaction" && action === "cancel") {
    assertNoExtra(rest, 1, "Usage: relo interaction cancel ID");
    assertAllowedOptions(options, []);
    return result("interaction.cancel", await client.cancelInteraction(rest[0]));
  }
  return undefined;
}
