import { parseDuration, numberOption, requireText } from "../args.mjs";
import { ApiError, UsageError } from "../errors.mjs";
import { resolveTargetDevices } from "./admin.mjs";
import { privacyOption } from "./notify.mjs";
import { activityContext, cardKey, creationContext, partialIdentity } from "../identity.mjs";
import { assertAllowedOptions, assertAtMostOne, assertNoExtra, booleanStdin, definedFields, deliveryGuard, enumOption, isIsoTimestamp, nullableNumberOption, optionalText, result, stdinDeviceIds, stdinObject, validateCanonicalId, validateIdempotencyKey } from "../support.mjs";

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
  return nullableNumberOption(value, "progress", { minimum: 0, maximum: 1 });
}

export function semanticStepsOption(options,stdin,storedLabels) {
  const explicitLabels = options.step?.length > 0 ? options.step : undefined;
  const stdinLabels = Array.isArray(stdin.steps)
    ? stdin.steps
    : Array.isArray(stdin.stepLabels) ? stdin.stepLabels : undefined;
  const labels = explicitLabels ?? stdinLabels ?? storedLabels;
  const currentValue = options["step-current"] ?? stdin.stepCurrent;
  if (labels === undefined && currentValue === undefined) return undefined;
  if (!labels?.length) {
    throw new UsageError("--step-current needs the card's steps", {
      hint: "Start the card with --step labels first, e.g. --step Build --step Test --step Deploy --step-current 1",
    });
  }
  const normalized = labels.map((label) => requireText(label,"step",40));
  if (normalized.length > 8) throw new UsageError("At most 8 --step labels are supported");
  const current = numberOption(currentValue,"step-current",{
    minimum: 1,maximum: normalized.length,integer: true,
  });
  if (current === undefined) throw new UsageError("--step-current is required with --step");
  return { labels: normalized,current };
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

/**
 * While a question waits on the card, the server keeps an update or start underneath it and sends
 * nothing to the phone yet; the card shows it once the question settles. That is success.
 */
export function cardResult(command, payload) {
  const behavior = payload?.activity?.presentation?.behavior?.type;
  if (payload?.activity?.state === "active" && (behavior === "approval" || behavior === "yes_no")
    && payload?.delivery?.durableCommands === 0) {
    return result(command, { ...payload, heldForQuestion: true },
      { message: "A question is waiting on this card; this shows on the card once it is answered." });
  }
  return result(command, deliveryGuard(payload));
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
    || interaction.prompt !== expected.prompt
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
      "title",
      "status",
      "detail",
      "progress",
      "progress-label",
      "step",
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
      "source",
      "topic",
      "project",
      "thread-name",
      "task-title",
      "stdin",
      "privacy",
    ]);
    const stdin = await stdinObject(options, dependencies);
    const context = creationContext(options, stdin, undefined, dependencies.identityDefaults());
    // Starting again reuses this work's running card: one card per agent session or topic.
    const manualKey = cardKey({ name: activityName(options,stdin), context, env: dependencies.env });
    const requestedStyle = options.style ?? stdin.style;
    const progress = numberOption(options.progress ?? stdin.progress, "progress", {
      minimum: 0,maximum: 1,
    });
    const progressLabel = optionalText(
      options["progress-label"] ?? stdin.progressLabel,"progress-label",32,
    );
    if (progressLabel !== undefined && progress === undefined) {
      throw new UsageError("--progress-label requires --progress when starting an activity");
    }
    const body = definedFields({
      key: manualKey,
      acquireMode: "ensure",
      replace: options.replace || booleanStdin(stdin.replace, "replace", false),
      title: requireText(options.title ?? stdin.title, "--title", 80),
      status: requireText(options.status ?? stdin.status, "--status", 60),
      detail: optionalText(options.detail ?? stdin.detail, "detail", 240),
      progress,
      progressLabel,
      steps: semanticStepsOption(options,stdin),
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
      ),
      context,
    });
    const key = validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey);
    const captured = await preparedActivityCommand({ config,client,operation: "start",key,body,
      selector: manualKey,originalOccurrence: stdin.occurredAt },dependencies);
    return cardResult(`activity.${action}`,await client.startActivity(captured.body,key));
  }

  if (group === "activity" && action === "status") {
    assertAllowedOptions(options,["name","source","project","topic","thread-name","stdin"]);
    const stdin = await stdinObject(options,dependencies);
    const target = cardTarget(rest,options,stdin,dependencies,"Usage: relo activity status [ID_OR_NAME]");
    const card = await activeCard(client,target);
    return result("activity.status",{ found: Boolean(card),activity: card,key: target });
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
      "step-current",
      "symbol",
      "style",
      "preset",
      "accent-color",
      "stale-after",
      "computer",
      "source",
      "topic",
      "project",
      "thread-name",
      "task-title",
      "if-sequence",
      "idempotency-key",
      "stdin",
    ]);
    const stdin = await stdinObject(options, dependencies);
    const target = cardTarget(rest,options,stdin,dependencies,"Usage: relo activity update [ID_OR_NAME] [options]");
    // Advancing a step needs only --step-current: the labels come from the card itself.
    const onlyStepCurrent = (options["step-current"] ?? stdin.stepCurrent) !== undefined
      && !(options.step?.length) && stdin.steps === undefined && stdin.stepLabels === undefined;
    const storedLabels = onlyStepCurrent ? cardStepLabels(await activeCard(client,target)) : undefined;
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
      title: optionalText(options.title ?? stdin.title, "title", 80),
      status: optionalText(options.status ?? stdin.status, "status", 60),
      detail: optionalText(rawDetail, "detail", 240),
      progress: progressOption(options, stdin),
      progressLabel: optionalText(
        options["progress-label"] ?? stdin.progressLabel,"progress-label",32,
      ),
      steps: semanticStepsOption(options,stdin,storedLabels),
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
    if (!Object.entries(body).some(([key, value]) => key !== "ifSequence" && value !== undefined)) {
      throw new UsageError("Activity update requires at least one changed field");
    }
    const key = validateIdempotencyKey(options["idempotency-key"], dependencies.generateIdempotencyKey);
    const captured = await preparedActivityCommand({ config,client,operation: "update",key,body,target,
      selector: target,originalOccurrence: stdin.occurredAt },dependencies);
    return cardResult("activity.update",await client.updateActivity(captured.target,captured.body,key));
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
    ]);
    const stdin = await stdinObject(options, dependencies);
    const target = cardTarget(rest,options,stdin,dependencies,"Usage: relo activity end [ID_OR_NAME] [options]");
    const rawDetail =
      options.detail !== undefined || options["clear-detail"]
        ? detailOption(options)
        : stdin.detail;
    const body = definedFields({
      status: requireText(options.status ?? stdin.status ?? "Complete", "status", 60),
      detail: optionalText(rawDetail, "detail", 240),
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
    const captured = await preparedActivityCommand({ config,client,operation: "end",key,body,target,
      selector: target,originalOccurrence: stdin.occurredAt },dependencies);
    return result("activity.end",deliveryGuard(await client.endActivity(captured.target,captured.body,key)));
  }

  if (group === "activity" && action === "get") {
    assertAllowedOptions(options, ["name"]);
    const target = activityTarget(rest, options, "Usage: relo activity get ID_OR_NAME|--name NAME");
    return result(
      "activity.get",
      await client.getActivity(target),
    );
  }

  if (group === "activity" && action === "list") {
    assertNoExtra(rest, 0, "Usage: relo activity list [--limit 1..100]");
    assertAllowedOptions(options, ["limit"]);
    const limit = numberOption(options.limit, "limit", { minimum: 1, maximum: 100, integer: true });
    return result("activity.list", await client.listActivities(limit));
  }
  return undefined;
}
