import {
  LOCK_SCREEN_MAX_CARDS,
  OWNER_STATE_TIMING,
  SESSIONS_VIEW_MAX,
  type NowItem,
  type NowSummary,
  type SessionRow,
} from "@relo/notification-contracts";

/**
 * The Now screen from derived items (pure): sections, the "since you looked" line, folds, the Lock
 * Screen's top cards by relevance and the Sessions view. Clients display it and refetch at refreshAt.
 */
export function buildNowSummary({ now,since,items,sessions }: {
  now: Date; since: Date; items: readonly NowItem[]; sessions: readonly SessionRow[];
}): NowSummary {
  const at = (value: string | null | undefined) => value ? Date.parse(value) : -Infinity;
  const sinceMs = since.valueOf();
  // When the outcome happened: its final declared write, or the moment a work was left unfinished.
  const finishedAt = (item: NowItem) => item.owner.state === "left_unfinished"
    ? at(item.owner.evidenceAt) + OWNER_STATE_TIMING.historySeconds * 1000 : at(item.declaredAt);
  const section = (name: NowItem["owner"]["now"]) => items.filter((item) => item.owner.now === name);
  const byEvidence = (a: NowItem,b: NowItem) => at(b.owner.evidenceAt) - at(a.owner.evidenceAt) || a.id.localeCompare(b.id);

  const needsYou = section("needs_you")
    .sort((a,b) => at(a.question?.askedAt) - at(b.question?.askedAt) || byEvidence(a,b));
  const recent = section("since_you_looked")
    .filter((item) => finishedAt(item) >= sinceMs)
    .sort((a,b) => finishedAt(b) - finishedAt(a) || a.id.localeCompare(b.id));
  const waitingOnYou = section("waiting_on_you").sort(byEvidence);
  const running = section("running").sort((a,b) => b.owner.relevance - a.owner.relevance || byEvidence(a,b));
  const quiet = section("quiet").sort(byEvidence);
  const paused = section("paused").sort(byEvidence);

  const lockScreenCards = items.filter((item) => item.owner.lockScreen !== "none")
    .sort((a,b) => b.owner.relevance - a.owner.relevance || byEvidence(a,b))
    .slice(0,LOCK_SCREEN_MAX_CARDS);

  const sessionRows = [...sessions].slice(0,SESSIONS_VIEW_MAX);
  const changes = [...items.map((item) => item.owner.nextChangeAt),...sessionRows.map((row) => row.nextChangeAt)]
    .filter((value): value is string => value !== null)
    .sort((a,b) => Date.parse(a) - Date.parse(b));

  return {
    serverTime: now.toISOString(),
    sinceYouLooked: {
      since: since.toISOString(),
      finished: recent.filter((item) => item.owner.state === "done").length,
      failed: recent.filter((item) => item.owner.state === "failed").length,
      waitingOnYou: waitingOnYou.length,
      stoppedWithoutFinishing: recent.filter((item) => item.owner.state === "left_unfinished").length,
      needsYou: needsYou.length,
    },
    needsYou,
    recent,
    waitingOnYou,
    running,
    quiet,
    paused,
    folds: { waitingOnYou: waitingOnYou.length,quiet: quiet.length,paused: paused.length },
    lockScreen: {
      cards: lockScreenCards.map((item) => item.id),
      needsYouCount: needsYou.length,
      focus: lockScreenCards[0]?.id ?? null,
    },
    sessions: {
      sessions: sessionRows,
      folds: { idle: sessionRows.filter((row) => row.fold === "idle").length },
    },
    refreshAt: changes[0] ?? null,
  };
}
