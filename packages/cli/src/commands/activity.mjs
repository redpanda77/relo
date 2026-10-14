import { cachedStepLabels,forgetCardText,saveCardText,sealCardRequest,sealedCardDirectory,withCardTextLock } from "../seal-card.mjs";
import { parseDuration, numberOption, progressCountLabel, progressFraction, requireText } from "../args.mjs";
import { ApiError, EXIT, ReloError, UsageError } from "../errors.mjs";
import { stepPosition } from "../output.mjs";
import { checkStepNames } from "../step-names.mjs";
import { resolveTargetDevices } from "./admin.mjs";
import { privacyOption } from "./notify.mjs";
import { randomUUID } from "node:crypto";
import { activityContext, agentSession, cardKey, creationContext, partialIdentity } from "../identity.mjs";
import { assertAllowedOptions, assertAtMostOne, dryRunResult, assertNoExtra, booleanStdin, definedFields, deliveryGuard, enumOption, fitRequiredText, fitText, isIsoTimestamp, optionalText, result, stdinDeviceIds, stdinObject, validateCanonicalId, validateIdempotencyKey } from "../support.mjs";

export const DEFAULT_LIST_LIMIT = 10;

export const TASK_ACTIVITY_STYLES = ["standard", "ring", "hero", "terminal", "steps"];

export const INTERACTIVE_ACTIVITY_STYLES = new Set(["approval", "shell", "verdict", "signal"]);

export const ACTIVITY_SYMBOLS = ["terminal", "code", "build", "success", "warning"];

export const ACTIVITY_PRESENTATION_PRESETS = ["automatic", "standard", "terminal", "steps"];

export const DEFAULT_ACTIVITY_EXPIRES_SECONDS = 28_800;

export const DEFAULT_ACTIVITY_STALE_SECONDS = 1_200;

export function activityName(options,stdin = {}) {
  const candidates = [options.name,stdin.name]
    .filter((value) => value !== undefined);
  if (candidates.length > 1) throw new UsageError("Use only one of --name or stdin name");
  return optionalText(candidates[0],"Activity name",100);
}

export function activityTarget(rest, options, usage) {
  const named = activityName(options);
  if (rest.length > 1 || (rest.length === 1 && named !== undefined)) {
    throw new UsageError(usage);
  }
  return requireText(rest[0] ?? named, "Activity ID or name", 128);
}

export function taskActivityStyle(value, defaultValue = "standard") {
  if (INTERACTIVE_ACTIVITY_STYLES.has(value)) {
    throw new UsageError(`--style ${value} is reserved for interactive Live Activities`);
  }
  return enumOption(value, "style", TASK_ACTIVITY_STYLES, defaultValue);
}

export function detailOption(options) {
  if (options.detail !== undefined && options["clear-detail"]) {
    throw new UsageError("--detail and --clear-detail cannot be used together");
  }
  return options["clear-detail"] ? null : options.detail;
}

export function progressOption(options, stdin) {
  if (options.progress !== undefined && options["clear-progress"]) {
    throw new UsageError("--progress and --clear-progress cannot be used together");
  }
  const value = options["clear-progress"] ? null : options.progress ?? stdin.progress;
  return progressFraction(value, "progress");
}

/** `--steps "Plan,Build,Ship"` or repeated `--step`: the labels sent with a card. */
export function stepLabelsOption(options, stdin) {
  if (options.steps !== undefined && options.step?.length > 0) {
    throw new UsageError("Use --steps \"A,B,C\" or repeated --step, not both");
  }
  if (options.steps !== undefined) {
    const labels = options.steps.split(",").map((label) => label.trim()).filter(Boolean);
    if (labels.length === 0) throw new UsageError("--steps needs at least one label, e.g. --steps \"Plan,Build,Ship\"");
    return labels;
  }
  if (options.step?.length > 0) return options.step;
  return Array.isArray(stdin.steps) ? stdin.steps : Array.isArray(stdin.stepLabels) ? stdin.stepLabels : undefined;
}

/** A 1-based number, or a step label (any case) among the labels being sent. */
function currentStepNumber(value, labels) {
  if (value !== undefined && !/^\d+$/u.test(String(value).trim())) {
    const wanted = String(value).trim().toLowerCase();
    const index = labels.findIndex((label) => label.toLowerCase() === wanted);
    if (index === -1) {
      throw new UsageError(`--step-current "${value}" is not one of the steps`, {
        hint: `Steps: ${labels.join(", ")}. Use a number (1-${labels.length}) or one of these names.`,
      });
    }
    return index + 1;
  }
  if (value !== undefined && Number(value) === 0) throw new UsageError("Steps are numbered from 1.");
  return numberOption(value, "step-current", { minimum: 1, maximum: labels.length, integer: true });
}

export function semanticStepsOption(options,stdin,storedLabels,{ defaultCurrent } = {}) {
  const sent = stepLabelsOption(options, stdin);
  const labels = sent ?? storedLabels;
  const currentValue = options["step-current"] ?? stdin.stepCurrent;
  if (labels === undefined && currentValue === undefined) return undefined;
  if (!labels?.length) {
    throw new UsageError("--step-current needs the card's steps", {
      hint: 'Start the card with --steps "Build,Test,Deploy" --step-current 1 first',
    });
  }
  const normalized = labels.map((label) => requireText(label,"step",40));
  if (normalized.length > 8) throw new UsageError("At most 8 steps are supported");
  // Names this command sends must say what happens; the card's own (read back for --next-step) are left as they are.
  if (sent !== undefined) checkStepNames(normalized);
  const current = currentValue === undefined ? defaultCurrent : currentStepNumber(currentValue, normalized);
  if (current === undefined) throw new UsageError("--step-current is required with --steps");
  return { labels: normalized,current };
}

/** The card's own steps, and which one is current (1-based; 0 when none is). */
export function cardStepProgress(card) {
  const labels = cardStepLabels(card);
  const items = card?.presentation?.components?.find((component) => component?.type === "steps")?.items ?? [];
  return { labels, current: items.findIndex((item) => item?.state === "current") + 1 };
}

export function activitySymbol(value, defaultValue) {
  return enumOption(value, "symbol", ACTIVITY_SYMBOLS, defaultValue);
}

export function accentColor(value, defaultValue) {
  const candidate = value ?? defaultValue;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || !/^#[0-9a-fA-F]{6}$/.test(candidate)) {
    throw new UsageError("--accent-color must use #RRGGBB format");
  }
  return candidate;
}

export async function preparedActivityCommand({ config,client,operation,key,body,target,selector,resolved,originalOccurrence },dependencies) {
  if (originalOccurrence !== undefined && (typeof originalOccurrence !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(originalOccurrence)
    || !Number.isFinite(Date.parse(originalOccurrence)))) throw new UsageError("occurredAt must be an original ISO occurrence time");
  const record = await dependencies.captureActivityCommand({ config,key,operation,selector,body,
    occurredAt: originalOccurrence ?? dependencies.commandOccurredAt,
    resolve: async () => {
      if (typeof target === "string" && /^act_[a-f0-9-]{36}$/u.test(target) && body.ifSequence !== undefined) {
        return { target,ifSequence: body.ifSequence };
      }
      const activity = resolved?.activity ?? (await client.getActivity(target)).activity;
      if (!activity || typeof activity.id !== "string" || !Number.isSafeInteger(activity.sequence)) {
        throw new ApiError("Relo returned an invalid activity identity.");
      }
      return { target: activity.id,ifSequence: body.ifSequence ?? activity.sequence };
    },
  },{ root: dependencies.activityCaptureDirectory,environment: dependencies.env });
  return { target: record.target ?? target,body: definedFields({ ...body,
    occurredAt: record.occurredAt,...(operation === "start" ? {} : { ifSequence: record.ifSequence }) }) };
}

/** Resolves the card a command addresses: an explicit ID or name, else this agent's card. */
export function cardTarget(rest, options, stdin, dependencies, usage) {
  const named = activityName(options, stdin);
  if (rest.length > 1 || (rest.length === 1 && named !== undefined)) throw new UsageError(usage);
  if (rest.length === 1) return requireText(rest[0], "Card ID or name", 128);
  const key = cardKey({ name: named, env: dependencies.env,
    context: partialIdentity(options, stdin, dependencies.identityDefaults()) });
  if (key === undefined) {
    throw new UsageError("Which card? Outside an agent session a card is named by its topic.", {
      hint: 'Add --topic "<the work>" (with --source/--project if not detected), or pass the card ID',
    });
  }
  return key;
}

export function cardStepLabels(card) {
  const steps = card?.presentation?.components?.find((component) => component?.type === "steps");
  const labels = steps?.items?.map((item) => item?.label).filter((label) => typeof label === "string");
  return labels?.length ? labels : undefined;
}

export async function activeCard(client, target) {
  try {
    const found = await client.getActivity(target);
    return found?.activity?.state === "active" ? found.activity : null;
  } catch (error) {
    if (error?.status === 404 || error?.code === "NOT_FOUND" || error?.code === "ACTIVITY_NOT_FOUND") return null;
    throw error;
  }
}

export const CONTINUE_HINT = 'relo activity update --status "…" --next-step (next phase) · relo activity end --status "…" (finished)';

/**
 * A second start for work whose card is already running continues it: nothing is sent and the card
 * is unchanged, and the reply is a success that names the card and the commands that move it on.
 * An agent that forgot it started gets its own card back instead of an error to work around.
 */
export function continuingResult(card, notes) {
  const step = stepPosition(card);
  return result("activity.start", { activity: card, disposition: "continuing", card: definedFields({ id: card?.id, state: card?.state, step }),
    next: CONTINUE_HINT },
  { message: "Continuing this work's running card; nothing was changed. Move it on with update, finish it with end.", notes });
}

const PROGRESS_FOLLOWS_STEPS = "progress follows this card's steps; use --next-step or --step-current";

/** A card with a steps component draws its progress from the steps, so a sent --progress changes nothing. */
function noteProgressOnSteps(sentProgress, payload, notes) {
  if (typeof sentProgress !== "number") return;
  const components = payload?.activity?.presentation?.components;
  if (Array.isArray(components) && components.some((component) => component?.type === "steps")) notes.push(PROGRESS_FOLLOWS_STEPS);
}

/**
 * While a question waits on the card, the server keeps an update or start underneath it and sends
 * nothing to the phone yet; the card shows it once the question settles. That is success.
 */
export function cardResult(command, payload, notes) {
  const behavior = payload?.activity?.presentation?.behavior?.type;
  if (payload?.activity?.state === "active" && (behavior === "approval" || behavior === "yes_no")
    && payload?.delivery?.durableCommands === 0) {
    return result(command, { ...payload, heldForQuestion: true },
      { message: "A question is waiting on this card; this shows on the card once it is answered.", notes });
  }
  return result(command, deliveryGuard(payload), { notes });
}

export function validateActivityWaitResponse(value, expected) {
  const interaction = value?.interaction;
  const delivery = value?.delivery;
  const validDeliveryMode = value?.deliveryMode === "queued_for_direct_apns"
    || value?.deliveryMode === "durable_inbox_refresh_only";
  const directDelivery = delivery?.apnsJobs > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.parentActivityId !== expected.parentActivityId
    || value.companionActivityId !== null
    || !interaction || typeof interaction !== "object" || Array.isArray(interaction)
    || !validateCanonicalId(interaction.id, "int")
    || !validateCanonicalId(interaction.eventId, "ntf")
    || interaction.eventId !== value.eventId
    || interaction.type !== expected.type
    // A sealed question comes back with the server's placeholder prompt.
    || (expected.prompt !== undefined && interaction.prompt !== expected.prompt)
    || typeof interaction.state !== "string" || interaction.state.length === 0
    || !isIsoTimestamp(interaction.expiresAt)
    || !Number.isInteger(value.queued) || value.queued < 0
    || typeof value.replayed !== "boolean"
    || !validDeliveryMode
    || directDelivery !== (value.deliveryMode === "queued_for_direct_apns")) {
    throw new ApiError("Activity wait response was invalid.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  return deliveryGuard({
    parentActivityId: value.parentActivityId,
    companionActivityId: value.companionActivityId,
    interaction: {
      id: interaction.id,
      eventId: interaction.eventId,
      type: interaction.type,
      prompt: interaction.prompt,
      state: interaction.state,
      expiresAt: interaction.expiresAt,
    },
    eventId: value.eventId,
    delivery: {
      eligibleDevices: delivery.eligibleDevices,
      durableCommands: delivery.durableCommands,
      apnsJobs: delivery.apnsJobs,
    },
    queued: value.queued,
    deliveryMode: value.deliveryMode,
    replayed: value.replayed,
  });
}

/** Runs this group's commands; returns undefined when the command is not one of them. */
export async function runActivityCommand(command) {
  const { options, group, action, rest, dependencies, config, client } = command;
  if (group === "activity" && action === "start") {
    assertNoExtra(rest, 0, `Usage: relo activity ${action} [--name NAME] --title TITLE --status TEXT [options]`);
    assertAllowedOptions(options, [
      "name",
      "replace",
      "new",
      "title",
      "status",
      "detail",
      "progress",
      "progress-label",
      "step",
      "steps",
      "step-current",
      "symbol",
      "style",
      "preset",
      "theme",
      "accent-color",
      "expires-in",
      "stale-after",
      "device",
      "idempotency-key",
      "computer",
      "account",
      "source",
      "topic",
      "project",
      "thread-name",
      "task-title",
      "stdin",
      "privacy",
      "dry-run",
    ]);
    const stdin = await stdinObject(options, dependencies);
    const context = creationContext(options, stdin, undefined, dependencies.creationDefaults(),
      'relo activity start --title "x"');
    const notes = [];
    const dryRun = Boolean(dependencies.dryRun);
    // Starting again reuses this work's running card: one card per agent session or topic.
    const named = activityName(options,stdin);
    const sharedKey = cardKey({ name: named, context, env: dependencies.env });
    // --new: a card of this run's own, never joining one another process already has running.
    const manualKey = options.new ? `${sharedKey.slice(0,80)}-${randomUUID().slice(0,8)}` : sharedKey;
    const requestedStyle = options.style ?? stdin.style;
    const progress = progressFraction(options.progress ?? stdin.progress, "progress");
    const progressLabel = fitText(
      options["progress-label"] ?? stdin.progressLabel ?? progressCountLabel(options.progress ?? stdin.progress),
      "progress-label",32,notes,
    );
    if (progressLabel !== undefined && progress === undefined) {
      throw new UsageError("--progress-label requires --progress when starting an activity");
    }
    if (progress !== undefined && (stepLabelsOption(options,stdin) !== undefined)) {
      throw new UsageError("--progress cannot be combined with --steps: the card's progress follows its steps", {
        hint: "Use --step-current or --next-step to move it, or drop --steps to use --progress",
      });
    }
    const body = definedFields({
      key: manualKey,
      acquireMode: "ensure",
      replace: options.replace || booleanStdin(stdin.replace, "replace", false),
      title: fitRequiredText(options.title ?? stdin.title, "--title", 80, notes),
      status: fitRequiredText(options.status ?? stdin.status, "--status", 60, notes),
      detail: fitText(options.detail ?? stdin.detail, "detail", 240, notes),
      progress,
      progressLabel,
      steps: semanticStepsOption(options,stdin,undefined,{ defaultCurrent: 1 }),
      symbol: activitySymbol(options.symbol ?? stdin.symbol),
      style: requestedStyle === undefined ? undefined : taskActivityStyle(requestedStyle),
      preset: enumOption(
        options.preset ?? stdin.preset,
        "preset",
        ACTIVITY_PRESENTATION_PRESETS,
      ),
      theme: enumOption(
        options.theme ?? stdin.theme,
        "theme",
        ["system", "light", "dark"],
      ),
      accentColor: accentColor(options["accent-color"] ?? stdin.accentColor),
      privacy: privacyOption(options, stdin),
      expiresInSeconds: parseDuration(options["expires-in"] ?? stdin.expiresInSeconds, {
        defaultSeconds: DEFAULT_ACTIVITY_EXPIRES_SECONDS,
        minimumSeconds: 60,
        maximumSeconds: 28_800,
      }),
      staleAfterSeconds: parseDuration(options["stale-after"] ?? stdin.staleAfterSeconds, {
        defaultSeconds: DEFAULT_ACTIVITY_STALE_SECONDS,
        minimumSeconds: 0,
        maximumSeconds: 28_800,
      }),
      deviceIds: await resolveTargetDevices(
        client,
        options.device.length > 0 ? options.device : stdinDeviceIds(stdin.deviceIds),
        { verify: !dryRun },
      ),
      context,
    });
    const key = validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey);
    if (dryRun) {
      if (body.deviceIds) notes.push("device IDs are not checked against the server in a dry run");
      return dryRunResult("activity start", body, notes);
    }
    const captured = await preparedActivityCommand({ config,client,operation: "start",key,body,
      selector: manualKey,originalOccurrence: stdin.occurredAt },dependencies);
    // A running card is never restarted: its title, topic and steps change only through update (ADR 0007).
    // A retry with its own --idempotency-key is the server's to replay, so it is not refused here.
    if (!options.new && !body.replace && options["idempotency-key"] === undefined) {
      const running = await activeCard(client,manualKey);
      if (running) return continuingResult(running,notes);
    }
    // Sealed end to end for this computer's verified phones (E5); the server sees placeholders.
    const sealed = await sealCardRequest({ body: captured.body,cardId: null,key,client,config,dependencies,notes,
      deviceIds: captured.body.deviceIds });
    const started = await client.startActivity(sealed.body,key);
    // Started by someone else between the check and the start: the server left it unchanged, and so does the cache.
    if (started?.disposition === "existing") return continuingResult(started.activity,notes);
    if (sealed.text && started?.activity?.id) await saveCardText(sealedCardDirectory(dependencies.env),started.activity.id,sealed.text);
    noteProgressOnSteps(progress,started,notes);
    if (started?.disposition === "reused" && !options.new && named === undefined && !agentSession(dependencies.env)) {
      notes.push("joined the card already running for this topic; if another process started it, pass --new (or set RELO_SESSION / --name) for a card of your own");
    }
    return cardResult(`activity.${action}`,started,notes);
  }

  if (group === "activity" && (action === "status" || action === "get")) {
    assertAllowedOptions(options,["name","source","project","topic","thread-name","stdin"]);
    const stdin = await stdinObject(options,dependencies);
    const target = cardTarget(rest,options,stdin,dependencies,`Usage: relo activity ${action} [ID_OR_NAME]`);
    // `get` with a card ID or name reads that card even when it has ended; with none, it is `status`.
    if (action === "get" && (rest.length > 0 || activityName(options,stdin) !== undefined)) {
      return result("activity.get",await client.getActivity(target));
    }
    const card = await activeCard(client,target);
    return result(`activity.${action}`,{ found: Boolean(card),activity: card,key: target });
  }

  if (group === "activity" && action === "diagnose") {
    assertAtMostOne(rest,"Usage: relo activity diagnose [ID_OR_NAME|--name NAME] [--wait [--timeout 30s]]");
    assertAllowedOptions(options,["name","wait","timeout"]);
    if (options.timeout !== undefined && !options.wait) {
      throw new UsageError("--timeout requires --wait");
    }
    const named = activityName(options);
    if (rest.length === 1 && named !== undefined) {
      throw new UsageError("Use an activity ID/name or --name, not both");
    }
    const explicitTarget = rest[0] ?? named;
    const selected = explicitTarget === undefined
      ? await client.resolveActivity({ current: true })
      : await client.getActivity(requireText(explicitTarget,"Activity ID or name",128));
    const activity = selected?.activity;
    if (!activity?.id) {
      throw new ApiError("No current Live Activity was found.",{
        status: 404,code: "ACTIVITY_NOT_FOUND",
      });
    }
    const timeoutSeconds = options.wait
      ? parseDuration(options.timeout,{ defaultSeconds: 30,minimumSeconds: 1,maximumSeconds: 300 })
      : 0;
    const startedAt = dependencies.now();
    const deadline = startedAt+timeoutSeconds*1_000;
    let diagnosis = await client.diagnoseActivity(activity.id);
    let polls = 1;
    while (options.wait && !["healthy","failed"].includes(diagnosis?.assessment?.status)
      && dependencies.now() < deadline) {
      await dependencies.sleep(Math.min(2_000,Math.max(0,deadline-dependencies.now())));
      diagnosis = await client.diagnoseActivity(activity.id);
      polls += 1;
    }
    const timedOut = Boolean(options.wait)
      && !["healthy","failed"].includes(diagnosis?.assessment?.status)
      && dependencies.now() >= deadline;
    return result("activity.diagnose",{
      ...diagnosis,
      wait: {
        requested: Boolean(options.wait),
        timeoutSeconds,
        elapsedMs: Math.max(0,dependencies.now()-startedAt),
        polls,
        timedOut,
      },
    },{
      message: `${diagnosis?.assessment?.code ?? "DIAGNOSIS_UNKNOWN"}: ${diagnosis?.assessment?.message ?? "No assessment returned."} ${diagnosis?.assessment?.nextAction ?? ""}`.trim(),
    });
  }

  if (group === "activity" && action === "update") {
    assertAllowedOptions(options, [
      "name",
      "title",
      "status",
      "detail",
      "clear-detail",
      "progress",
      "clear-progress",
      "progress-label",
      "step",
      "steps",
      "step-current",
      "next-step",
      "symbol",
      "style",
      "preset",
      "accent-color",
      "stale-after",
      "computer",
      "account",
      "source",
      "topic",
      "project",
      "thread-name",
      "task-title",
      "if-sequence",
      "idempotency-key",
      "stdin",
      "dry-run",
    ]);
    const stdin = await stdinObject(options, dependencies);
    const dryRun = Boolean(dependencies.dryRun);
    const notes = [];
    const target = cardTarget(rest,options,stdin,dependencies,"Usage: relo activity update [ID_OR_NAME] [options]");
    // Advancing a step needs only --step-current or --next-step: the labels come from the card itself.
    const sendsSteps = stepLabelsOption(options,stdin) !== undefined;
    const wantsNext = Boolean(options["next-step"]);
    if (wantsNext && (sendsSteps || (options["step-current"] ?? stdin.stepCurrent) !== undefined)) {
      throw new UsageError("--next-step cannot be combined with --steps, --step or --step-current");
    }
    const needsCard = wantsNext || (!sendsSteps && (options["step-current"] ?? stdin.stepCurrent) !== undefined);
    if (dryRun && needsCard) notes.push("step resolution skipped in a dry run: the card's own steps are not read");
    const stepCard = needsCard && !dryRun ? await activeCard(client,target) : undefined;
    if (needsCard && !dryRun && !stepCard) {
      throw new ApiError("activity_terminal",{ status: 409,code: "ACTIVITY_TERMINAL" });
    }
    // A sealed card's real step labels live only in this computer's cache; the server holds "Step n".
    // Without a matching cache the labels are the server's, marked so they are never sealed as text.
    const serverLabels = needsCard ? cardStepLabels(stepCard) : undefined;
    const cachedLabels = needsCard ? await cachedStepLabels(stepCard?.id,serverLabels?.length,dependencies) : undefined;
    const storedLabels = cachedLabels ?? serverLabels;
    const fromServer = (steps) => (steps && cachedLabels === undefined && !sendsSteps ? { ...steps,labelsFromServer: true } : steps);
    let nextStep;
    if (wantsNext && !dryRun) {
      const progress = cardStepProgress(stepCard);
      if (!progress.labels) {
        throw new UsageError("This card has no steps to advance.", {
          hint: 'Set them first: relo activity update --steps "Plan,Build,Ship" --step-current 1',
        });
      }
      if (progress.current >= progress.labels.length) {
        throw new UsageError("Already on the last step.", { hint: "Finish the card: relo activity end --status …" });
      }
      nextStep = progress.current + 1;
    }
    const rawDetail =
      options.detail !== undefined || options["clear-detail"]
        ? detailOption(options)
        : stdin.detail;
    const requestedPreset = enumOption(
      options.preset ?? stdin.preset,
      "preset",
      ACTIVITY_PRESENTATION_PRESETS,
    );
    const requestedUpdateStyle = options.style ?? stdin.style
      ?? (requestedPreset === undefined || requestedPreset === "automatic" ? undefined : requestedPreset);
    const body = definedFields({
      title: fitText(options.title ?? stdin.title, "title", 80, notes),
      status: fitText(options.status ?? stdin.status, "status", 60, notes),
      detail: fitText(rawDetail, "detail", 240, notes),
      progress: progressOption(options, stdin),
      progressLabel: fitText(
        options["progress-label"] ?? stdin.progressLabel
          ?? (options["clear-progress"] ? undefined : progressCountLabel(options.progress ?? stdin.progress)),
        "progress-label",32,notes,
      ),
      steps: dryRun && needsCard ? undefined
        : fromServer(nextStep === undefined
          ? semanticStepsOption(options,stdin,storedLabels)
          : { labels: storedLabels,current: nextStep }),
      symbol: activitySymbol(options.symbol ?? stdin.symbol),
      accentColor: accentColor(options["accent-color"] ?? stdin.accentColor),
      style:
        requestedUpdateStyle === undefined
          ? undefined
          : taskActivityStyle(requestedUpdateStyle, undefined),
      staleAfterSeconds:
        options["stale-after"] === undefined && stdin.staleAfterSeconds === undefined
          ? undefined
          : parseDuration(options["stale-after"] ?? stdin.staleAfterSeconds, {
              minimumSeconds: 0,
              maximumSeconds: 28_800,
            }),
      context: activityContext(options, stdin),
      ifSequence: numberOption(options["if-sequence"] ?? stdin.ifSequence, "if-sequence", {
        minimum: 0,
        integer: true,
      }),
    });
    if (!(dryRun && needsCard) && !Object.entries(body).some(([key, value]) => key !== "ifSequence" && value !== undefined)) {
      throw new UsageError("Activity update requires at least one changed field");
    }
    const key = validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey);
    if (dryRun) {
      return dryRunResult("activity update", { target, ...body }, notes);
    }
    const captured = await preparedActivityCommand({ config,client,operation: "update",key,body,target,
      selector: target,originalOccurrence: stdin.occurredAt },dependencies);
    const directory = sealedCardDirectory(dependencies.env);
    const updated = await withCardTextLock(directory,captured.target,async () => {
      const sealed = await sealCardRequest({ body: captured.body,cardId: captured.target,key,client,config,dependencies,notes });
      const reply = await client.updateActivity(captured.target,sealed.body,key);
      if (sealed.text) await saveCardText(directory,captured.target,sealed.text);
      return reply;
    });
    noteProgressOnSteps(body.progress,updated,notes);
    return cardResult("activity.update",updated,notes);
  }

  if (group === "activity" && action === "end") {
    assertAllowedOptions(options, [
      "name",
      "status",
      "detail",
      "clear-detail",
      "progress",
      "clear-progress",
      "symbol",
      "accent-color",
      "dismiss-after",
      "if-sequence",
      "idempotency-key",
      "stdin",
      "dry-run",
    ]);
    const stdin = await stdinObject(options, dependencies);
    const target = cardTarget(rest,options,stdin,dependencies,"Usage: relo activity end [ID_OR_NAME] [options]");
    const rawDetail =
      options.detail !== undefined || options["clear-detail"]
        ? detailOption(options)
        : stdin.detail;
    const notes = [];
    const body = definedFields({
      status: fitRequiredText(options.status ?? stdin.status ?? "Complete", "status", 60, notes),
      detail: fitText(rawDetail, "detail", 240, notes),
      progress: progressOption(options, stdin),
      symbol: activitySymbol(options.symbol ?? stdin.symbol, "success"),
      accentColor: accentColor(options["accent-color"] ?? stdin.accentColor),
      dismissAfterSeconds:
        options["dismiss-after"] !== undefined || stdin.dismissAfterSeconds !== undefined
          ? parseDuration(options["dismiss-after"] ?? stdin.dismissAfterSeconds, {
              minimumSeconds: 0,
              maximumSeconds: 14_400,
            })
          : 300,
      ifSequence: numberOption(options["if-sequence"] ?? stdin.ifSequence, "if-sequence", {
        minimum: 0,
        integer: true,
      }),
    });
    const key = validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey);
    if (dependencies.dryRun) return dryRunResult("activity end", { target, ...body }, notes);
    const captured = await preparedActivityCommand({ config,client,operation: "end",key,body,target,
      selector: target,originalOccurrence: stdin.occurredAt },dependencies);
    const directory = sealedCardDirectory(dependencies.env);
    const ended = await withCardTextLock(directory,captured.target,async () => {
      const sealed = await sealCardRequest({ body: captured.body,cardId: captured.target,key,client,config,dependencies,notes });
      const reply = deliveryGuard(await client.endActivity(captured.target,sealed.body,key));
      if (sealed.text) await forgetCardText(directory,captured.target);
      return reply;
    });
    return result("activity.end",ended,{ notes });
  }

  if (group === "activity" && action === "list") {
    assertNoExtra(rest, 0, "Usage: relo activity list [--limit 1..100]");
    assertAllowedOptions(options, ["limit"]);
    const limit = numberOption(options.limit, "limit", { minimum: 1, maximum: 100, integer: true });
    // The server returns its latest 100 whatever the limit; an agent needs the few that matter.
    const listed = await client.listActivities(limit);
    const activities = Array.isArray(listed?.activities) ? listed.activities.slice(0, limit ?? DEFAULT_LIST_LIMIT) : listed?.activities;
    return result("activity.list", { ...listed, activities });
  }
  return undefined;
}
