import { forgetCardText, sealCardRequest, withCardTextLock } from "../crypto/seal-card.mjs";
import { activityName, activeCard } from "./cards.mjs";
import { sealedCardDirectory } from "../crypto/paths.mjs";
import { assertAtMostOne, assertNoExtra, definedFields, enumOption, fitRequiredText, fitText, numberOption, parseDuration, progressFraction, requireText, validateIdempotencyKey } from "../shared/validate.mjs";
import { ApiError, UsageError } from "../shared/errors.mjs";
import { cardKey, partialIdentity } from "./card-context.mjs";
import { dryRunResult, result } from "../shared/outcome.mjs";
import { deliveryGuard } from "./delivery.mjs";
import { stdinObject } from "../shared/stdin.mjs";

const DEFAULT_LIST_LIMIT = 10;

const ACTIVITY_SYMBOLS = ["terminal", "code", "build", "success", "warning"];

function detailOption(options) {
  if (options.detail !== undefined && options["clear-detail"]) {
    throw new UsageError("--detail and --clear-detail cannot be used together");
  }
  return options["clear-detail"] ? null : options.detail;
}

function progressOption(options, stdin) {
  if (options.progress !== undefined && options["clear-progress"]) {
    throw new UsageError("--progress and --clear-progress cannot be used together");
  }
  const value = options["clear-progress"] ? null : options.progress ?? stdin.progress;
  return progressFraction(value, "progress");
}

function activitySymbol(value, defaultValue) {
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

async function preparedActivityCommand({ config,client,operation,key,body,target,selector,resolved,originalOccurrence },dependencies) {
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
  },{ root: dependencies.activityCaptureDirectory,environment: dependencies.env,home: dependencies.home });
  return { target: record.target ?? target,body: definedFields({ ...body,
    occurredAt: record.occurredAt,...(operation === "start" ? {} : { ifSequence: record.ifSequence }) }) };
}

/** Resolves the card a command addresses: an explicit ID or name, else this agent's card. */
function cardTarget(rest, options, stdin, dependencies, usage) {
  const named = activityName(options, stdin);
  if (rest.length > 1 || (rest.length === 1 && named !== undefined)) throw new UsageError(usage);
  if (rest.length === 1) return requireText(rest[0], "Card ID or name", 128);
  const key = cardKey({ name: named, env: dependencies.env, owner: dependencies.messages.cardOwner(dependencies),
    context: partialIdentity(options, stdin, dependencies.identityDefaults()) });
  if (key === undefined) {
    throw new UsageError("Which card? Outside a session a card is named by its topic.", {
      hint: 'Add --topic "<the work>" (with --source/--project if not detected), or pass the card ID',
    });
  }
  return key;
}

/** Runs this group's commands; returns undefined when the command is not one of them. */
export async function runActivityCommand(command) {
  const { options, group, action, rest, dependencies, config, client } = command;
  if (group === "activity" && (action === "status" || action === "get")) {
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

  if (group === "activity" && action === "end") {
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
    const directory = sealedCardDirectory(dependencies);
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
    const limit = numberOption(options.limit, "limit", { minimum: 1, maximum: 100, integer: true });
    // The server returns its latest 100 whatever the limit; an agent needs the few that matter.
    const listed = await client.listActivities(limit);
    const activities = Array.isArray(listed?.activities) ? listed.activities.slice(0, limit ?? DEFAULT_LIST_LIMIT) : listed?.activities;
    return result("activity.list", { ...listed, activities });
  }
  return undefined;
}
