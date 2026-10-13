import { parseDuration } from "../args.mjs";
import { AuthError, EXIT, UsageError } from "../errors.mjs";
import { assertAllowedOptions, assertNoExtra, result } from "../support.mjs";

const POLL_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 30;

/** One answer as one line: what was decided, for which question, and where to resume. */
export function answerLine(answer) {
  const chosen = answer?.type === "choice" && typeof answer?.response?.optionId === "string" ? answer.response : undefined;
  return {
    id: answer.id,
    eventId: answer.eventId,
    state: chosen ? "chosen" : answer.state,
    ...(answer.action ? { action: answer.action } : {}),
    ...(chosen ? { option: chosen.optionId, label: chosen.label } : {}),
    ...(answer.correlationId ? { correlationId: answer.correlationId } : {}),
    respondedAt: answer.respondedAt,
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
  assertAllowedOptions(options, ["since", "once", "timeout"]);
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
  let received = 0;
  let failures = 0;
  for (;;) {
    const waitSeconds = Math.max(0, Math.min(POLL_SECONDS, Math.ceil((deadline - now()) / 1_000)));
    try {
      const page = await client.listAnswers({ after: cursor, since: cursor ? undefined : since, timeoutSeconds: waitSeconds });
      failures = 0;
      cursor = page.cursor ?? cursor;
      for (const answer of page.answers ?? []) {
        dependencies.emit(answerLine(answer));
        received += 1;
      }
    } catch (error) {
      // A revoked or expired login never comes back by waiting; anything else is retried.
      if (error instanceof AuthError || error instanceof UsageError || error?.exitCode === EXIT.AUTH || options.once) throw error;
      failures += 1;
      await dependencies.sleep(Math.min(MAX_BACKOFF_SECONDS, 2 ** failures) * 1_000);
    }
    if (options.once || now() >= deadline) break;
  }
  return result("listen", { cursor, received });
}
