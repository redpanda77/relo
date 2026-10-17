import { answerProblem, currentKeyListing, recalledQuestion } from "../crypto/answer-verify.mjs";
import { isBrowserId, strictFor } from "../crypto/trust.mjs";
import { assertNoExtra, parseDuration } from "../shared/validate.mjs";
import { keyStorePath, loadKeyStore } from "../crypto/keystore.mjs";
import { AuthError, EXIT, UsageError } from "../shared/errors.mjs";
import { result } from "../shared/outcome.mjs";

const POLL_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 30;
// Positive answers a phone signs; the same set `relo ask` verifies before acting.
const SIGNED_STATES = new Set(["approved", "yes", "replied", "completed"]);

/**
 * One answer as one line: what was decided, for which question, who signed it, and where to resume.
 * `verdict` is null (no trusted phone on this server: nothing to check), or the verification result.
 */
function answerLine(answer, verdict = null) {
  const response = answer?.response ?? {};
  const keyId = typeof response.e2eeKeyId === "string" ? response.e2eeKeyId : undefined;
  if (verdict?.problem) {
    // Refused: the decision fields are withheld so nothing downstream acts on an unverified answer.
    return { id: answer.id, eventId: answer.eventId, state: "unverified", reason: verdict.problem, cursor: answer.cursor };
  }
  const chosen = answer?.type === "choice" && typeof answer?.response?.optionId === "string" ? answer.response : undefined;
  return {
    id: answer.id,
    eventId: answer.eventId,
    state: chosen ? "chosen" : answer.state,
    ...(answer.action ? { action: answer.action } : {}),
    ...(chosen ? { option: chosen.optionId, label: chosen.label } : {}),
    ...(answer.correlationId ? { correlationId: answer.correlationId } : {}),
    respondedAt: answer.respondedAt,
    ...(typeof response.e2eeSignature === "string" ? { signed: true, device: { id: answer.respondingDevice?.id ?? null, keyId: keyId ?? null }, signature: {
      keyId: keyId ?? null, signedAt: response.e2eeSignedAt ?? null, sig: response.e2eeSignature,
      question: response.e2eeQuestion ?? null, questionSig: response.e2eeQuestionSignature ?? null,
    } } : {}),
    ...(verdict ? { verified: true } : {}),
    cursor: answer.cursor,
  };
}

/**
 * `relo listen`: every answer to the questions this login asked, as one JSON line each, over one
 * long-lived connection the app opens (it works behind NAT and on private networks). Each line
 * carries a cursor; `--since CURSOR` resumes after a restart. Without it, only new answers.
 */
export async function runListenCommand(command) {
  const { options, group, action, rest, client, dependencies } = command;
  if (group !== "listen") return undefined;
  assertNoExtra([action, ...rest].filter((word) => word !== undefined), 0, "Usage: relo listen [--since CURSOR|TIME] [--once] [--timeout DURATION]");
  let cursor;
  let since;
  if (options.since !== undefined) {
    if (/^\d{4}-\d{2}-\d{2}T/u.test(options.since) && !Number.isNaN(Date.parse(options.since))) since = options.since;
    else if (/^[A-Za-z0-9_-]{16,512}$/u.test(options.since)) cursor = options.since;
    else throw new UsageError("--since takes a cursor from an earlier line or an ISO time", { hint: "relo listen --since 2026-10-13T09:00:00Z" });
  }
  const stopAfter = options.timeout === undefined ? undefined
    : parseDuration(options.timeout, { minimumSeconds: 1, maximumSeconds: 30 * 86_400 });
  const now = () => dependencies.now();
  const deadline = stopAfter === undefined ? Infinity : now() + stopAfter * 1_000;
  // Once this computer trusts a phone on this server, every positive answer must carry its valid signature.
  let store = null;
  const apiUrl = client?.apiUrl;
  if (apiUrl && dependencies.configPath) {
    const loaded = await loadKeyStore(keyStorePath(dependencies.configPath(), dependencies.env));
    if (loaded.identity && Object.keys(loaded.trusted).some((entry) => entry.startsWith(`${apiUrl}|`))) store = loaded;
  }
  // A linked browser's answer is checked against the key listing now (its link may have lapsed).
  const verdictFor = async (answer) => {
    if (!store || !SIGNED_STATES.has(answer?.state)) return null;
    const devices = isBrowserId(answer?.respondingDevice?.id) && !strictFor(store, apiUrl) ? await currentKeyListing(client) : undefined;
    // A question this computer sealed is checked against its context too, so an answer on another copy can verify.
    const asked = answer?.answeredCopy ? await recalledQuestion(dependencies, answer.id) : null;
    return { problem: answerProblem(answer, store, apiUrl, asked ?? {}, now(), { devices }) };
  };
  let received = 0;
  let refused = 0;
  let failures = 0;
  for (;;) {
    const waitSeconds = Math.max(0, Math.min(POLL_SECONDS, Math.ceil((deadline - now()) / 1_000)));
    try {
      const page = await client.listAnswers({ after: cursor, since: cursor ? undefined : since, timeoutSeconds: waitSeconds });
      failures = 0;
      cursor = page.cursor ?? cursor;
      for (const answer of page.answers ?? []) {
        const verdict = await verdictFor(answer);
        dependencies.emit(answerLine(answer, verdict));
        if (verdict?.problem) refused += 1;
        else received += 1;
      }
    } catch (error) {
      // A revoked or expired login never comes back by waiting; anything else is retried.
      if (error instanceof AuthError || error instanceof UsageError || error?.exitCode === EXIT.AUTH || options.once) throw error;
      failures += 1;
      await dependencies.sleep(Math.min(MAX_BACKOFF_SECONDS, 2 ** failures) * 1_000);
    }
    if (options.once || now() >= deadline) break;
  }
  return result("listen", { cursor, received, ...(refused ? { refused } : {}) });
}
