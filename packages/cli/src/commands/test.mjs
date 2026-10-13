import { parseDuration } from "../args.mjs";
import { ApiError, EXIT, ReloError, TerminalInteractionError } from "../errors.mjs";
import { assertAllowedOptions, assertNoExtra, result, validateIdempotencyKey } from "../support.mjs";
import { DEFAULT_ACTIVITY_STALE_SECONDS, validateActivityWaitResponse } from "./activity.mjs";
import { listAllDevices } from "./admin.mjs";
import { agentWaitSeconds, waitForInteraction } from "./notify.mjs";

const USAGE = "Usage: relo test [--again] [--timeout 100s]";
const PROMPT = "Can you see this card on your iPhone?";
const QUESTION_SECONDS = 300;
const CARD_KEY = "relo-test";

// The same checks as skills/relo-notifications/references/troubleshooting.md ("The phone test failed").
export const PHONE_CHECKS = "On the iPhone: iOS Settings > Relo > Live Activities is on, and the Relo app is signed in to this "
  + "server. Then check the phone is listed with Live Activities on (relo devices list) and run relo test --again.";

const failure = (message, code, exitCode, details) => new ReloError(message, { code, exitCode, details });

export const isLiveDevice = (device) => device?.liveActivityAuthorization === "authorized";

/** Records (or clears) what the first phone test learned. Environment credentials have no file to write. */
async function remember(dependencies, config, patch) {
  if (config.source === "environment") return;
  const path = dependencies.configPath();
  const stored = await dependencies.loadStoredConfig(path);
  await dependencies.writeConfig(path, { ...stored, ...patch }, { expectedRevision: stored.revision });
}

/** `relo test`: the first end-to-end check, done once. Asks on a short card whether the owner can see it. */
export async function runTestCommand(command) {
  const { options, group, action, rest, client, config, dependencies } = command;
  if (group !== "test") return undefined;
  assertNoExtra([action, ...rest].filter((word) => word !== undefined), 0, USAGE);
  assertAllowedOptions(options, ["again", "timeout"]);
  const again = Boolean(options.again);
  const timeoutSeconds = parseDuration(options.timeout, {
    defaultSeconds: Math.min(QUESTION_SECONDS, agentWaitSeconds(dependencies) ?? QUESTION_SECONDS),
    minimumSeconds: 1, maximumSeconds: QUESTION_SECONDS,
  });

  const { devices } = await listAllDevices(client);
  if (!again && config.phoneTest) {
    return result("test", { verified: true, already: true, ...config.phoneTest });
  }
  const live = devices.filter(isLiveDevice);
  if (live.length === 0) {
    throw failure(devices.length === 0 ? "No iPhone is signed in to Relo yet." : "No iPhone has Live Activities on.",
      "NO_PHONE", EXIT.NO_DELIVERY, { hint: PHONE_CHECKS });
  }

  const finish = async (cardId, status, symbol) => {
    if (!cardId) return;
    await client.endActivity(cardId, { status, symbol, dismissAfterSeconds: 60 },
      `${validateIdempotencyKey(undefined, dependencies.generateIdempotencyKey)}:end`).catch(() => {});
  };

  let pending = again ? undefined : config.pendingTest;
  let interactionId = pending?.interactionId;
  let cardId = pending?.cardId;
  let answered;
  for (;;) {
    if (interactionId === undefined) {
      const key = validateIdempotencyKey(undefined, dependencies.generateIdempotencyKey);
      const started = await client.startActivity({
        key: CARD_KEY, acquireMode: "ensure",
        title: "Relo test", status: "Tap Yes if you can see this", symbol: "success",
        context: { providerName: "Relo", project: "Relo setup", threadName: "Phone test", providerThreadId: "relo-test" },
        expiresInSeconds: 900, staleAfterSeconds: DEFAULT_ACTIVITY_STALE_SECONDS,
      }, `${key}:card`);
      cardId = started?.activity?.id;
      if (!started?.delivery?.durableCommands) {
        await finish(cardId, "Ended", "warning");
        throw failure("The test card did not reach any iPhone.", "NO_PHONE", EXIT.NO_DELIVERY, { hint: PHONE_CHECKS });
      }
      const created = validateActivityWaitResponse(await client.createActivityWait(cardId, {
        type: "yes_no", prompt: PROMPT, expiresInSeconds: QUESTION_SECONDS,
      }, `${key}:ask`), { parentActivityId: cardId, type: "yes_no", prompt: PROMPT });
      interactionId = created.interaction.id;
      await remember(dependencies, config, { pendingTest: { interactionId, cardId, startedAt: new Date(dependencies.now()).toISOString() } });
    }
    try {
      answered = await waitForInteraction(client, interactionId, timeoutSeconds, dependencies);
      break;
    } catch (error) {
      if (pending !== undefined && error instanceof ApiError && error.status === 404) {
        // The remembered question is gone: forget it and ask afresh.
      } else if (error instanceof TerminalInteractionError) {
        const state = error.details?.state;
        if (state === "timeout") {
          throw failure("No answer yet; the test question is still open on the iPhone.", "PHONE_TEST_PENDING", EXIT.TERMINAL, {
            state: "timeout", hint: `Ask the owner to look at their iPhone, then run again: relo test. ${PHONE_CHECKS}`,
          });
        }
        await remember(dependencies, config, { pendingTest: undefined });
        if (state === "no" || state === "denied") {
          await finish(cardId, "Test ended", "warning");
          throw failure("The owner could not see the test card.", "PHONE_TEST_NO", EXIT.NEGATIVE, { state: "no", hint: PHONE_CHECKS });
        }
        if (pending === undefined) {
          await finish(cardId, "Test ended", "warning");
          throw failure(`The test question closed with no answer (${state}).`, "PHONE_TEST_CLOSED", EXIT.TERMINAL, {
            state, hint: "Run it again: relo test --again",
          });
        }
      } else {
        throw error;
      }
      // A stale remembered question (expired, canceled, or gone): start over exactly once.
      await remember(dependencies, config, { pendingTest: undefined });
      pending = undefined;
      interactionId = undefined;
      cardId = undefined;
    }
  }

  const interaction = answered?.interaction ?? answered;
  const deviceId = [interaction?.answeredByDeviceId, interaction?.deviceId].find((id) => devices.some((device) => device.deviceId === id))
    ?? live[0].deviceId;
  const record = { verifiedAt: new Date(dependencies.now()).toISOString(), deviceId };
  await remember(dependencies, config, { phoneTest: record, pendingTest: undefined });
  await finish(cardId, "Relo works", "success");
  return result("test", { verified: true, ...record },
    config.source === "environment" ? { message: "RELO_TOKEN credentials keep no config file, so this result is not remembered." } : undefined);
}
