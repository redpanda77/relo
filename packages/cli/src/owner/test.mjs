import { assertNoExtra, parseDuration, validateIdempotencyKey } from "../shared/validate.mjs";
import { rememberQuestion } from "../crypto/answer-verify.mjs";
import { forgetCardText, saveCardText, sealCardRequest } from "../crypto/seal-card.mjs";
import { sealedCardDirectory } from "../crypto/paths.mjs";
import { sealQuestion } from "../crypto/seal-notice.mjs";
import { ApiError, EXIT, ReloError, TerminalInteractionError } from "../shared/errors.mjs";
import { result } from "../shared/outcome.mjs";
import { DEFAULT_ACTIVITY_STALE_SECONDS, validateActivityWaitResponse } from "../messages/cards.mjs";
import { listAllDevices } from "../shared/devices.mjs";
import { messageWaitSeconds, waitForInteraction } from "../messages/notify.mjs";

const USAGE = "Usage: relo test [--again] [--timeout 100s]";
const PROMPT = "Can you see this card on your iPhone?";
const QUESTION_SECONDS = 300;
const CARD_KEY = "relo-test";

// The same checks as skills/relo-notifications/references/troubleshooting.md ("The phone test failed").
const PHONE_CHECKS = "On the iPhone: iOS Settings > Relo > Live Activities is on, and the Relo app is signed in to this "
  + "server. Then check the phone is listed with Live Activities on (relo devices list) and run relo test --again.";

const failure = (message, code, exitCode, details) => new ReloError(message, { code, exitCode, details });

const isLiveDevice = (device) => device?.liveActivityAuthorization === "authorized";

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
  const again = Boolean(options.again);
  const timeoutSeconds = parseDuration(options.timeout, {
    defaultSeconds: Math.min(QUESTION_SECONDS, messageWaitSeconds(dependencies) ?? QUESTION_SECONDS),
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

  // On an account that requires end-to-end encryption the test card and question are sealed
  // like any other; otherwise the server refuses readable text and the test could never pass.
  const notes = [];
  const finish = async (cardId, status, symbol) => {
    if (!cardId) return;
    const key = validateIdempotencyKey(undefined, dependencies.generateIdempotencyKey);
    try {
      const sealed = await sealCardRequest({ body: { status, symbol, dismissAfterSeconds: 60 }, cardId, key, client, config, dependencies, notes });
      await client.endActivity(cardId, sealed.body, `${key}:end`);
      if (sealed.text) await forgetCardText(sealedCardDirectory(dependencies), cardId);
    } catch {
      // Ending the test card is best effort; it goes stale on its own.
    }
  };

  let pending = again ? undefined : config.pendingTest;
  let interactionId = pending?.interactionId;
  let cardId = pending?.cardId;
  let answered;
  for (;;) {
    if (interactionId === undefined) {
      const key = validateIdempotencyKey(undefined, dependencies.generateIdempotencyKey);
      const card = await sealCardRequest({ body: {
        key: CARD_KEY, acquireMode: "ensure",
        title: "Relo test", status: "Tap Yes if you can see this", symbol: "success",
        context: { providerName: "Relo", project: "Relo setup", threadName: "Phone test", providerThreadId: "relo-test" },
        expiresInSeconds: 900, staleAfterSeconds: DEFAULT_ACTIVITY_STALE_SECONDS,
      }, cardId: null, key: CARD_KEY, client, config, dependencies, notes });
      const started = await client.startActivity(card.body, `${key}:card`);
      cardId = started?.activity?.id;
      if (card.text && cardId) await saveCardText(sealedCardDirectory(dependencies), cardId, card.text);
      if (!started?.delivery?.durableCommands) {
        await finish(cardId, "Ended", "warning");
        throw failure("The test card did not reach any iPhone.", "NO_PHONE", EXIT.NO_DELIVERY, { hint: PHONE_CHECKS });
      }
      const askedAt = new Date(dependencies.now());
      const sealed = (await sealQuestion({ title: "Relo test", prompt: PROMPT, key: `${key}:ask`, client, config, dependencies, notes }))?.sealed;
      const created = validateActivityWaitResponse(await client.createActivityWait(cardId, {
        type: "yes_no", ...(sealed ? { sealed } : { prompt: PROMPT }), expiresInSeconds: QUESTION_SECONDS,
      }, `${key}:ask`), { parentActivityId: cardId, type: "yes_no", prompt: sealed ? undefined : PROMPT });
      interactionId = created.interaction.id;
      if (sealed) await rememberQuestion(dependencies, { interactionId,
        questionContext: sealed.content.context, askedAt: askedAt.toISOString() });
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
          throw failure(`The test question closed with no answer (${state}).`, "PHONE_TEST_CLOSED", EXIT.CLOSED, {
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
