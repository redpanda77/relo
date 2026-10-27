/**
 * History's rules, as the iPhone reads them (HistoryTimeline, HistoryRow.Outcome, NowSignal), so the
 * Dashboard and the server speak them in the same words. History is what is over: running work and
 * a question still waiting belong to Now, and a round shows once (its outcome notification folds into
 * the round's card). The server classifies each row (`historySignal` on a summary); this module holds
 * the meanings, their order and their words.
 */
import { z } from "zod";
import { ORB_SIGNALS, type OrbSignal } from "./orb-palette.js";

/** What a History row means: its dot, its bar in the day's chart and its count chip. */
export type HistorySignal = OrbSignal;

/** The meanings a settled row can have, in display order (the iPhone's NowSignal order). */
export const HISTORY_ENDINGS = ORB_SIGNALS.filter(
  (signal): signal is "done" | "attention" | "failed" | "message" => signal !== "running" && signal !== "needsYou",
);
export type HistoryEnding = (typeof HISTORY_ENDINGS)[number];
export const historyEndingSchema = z.enum(["done", "attention", "failed", "message"]);

/** History's kinds, as the iPhone's filter sheet names them (Show: All, Work, Messages, Decisions). */
export const HISTORY_KINDS = [
  ["work", "Work"],
  ["message", "Messages"],
  ["decision", "Decisions"],
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number][0];
export const historyKindSchema = z.enum(["work", "message", "decision"]);

/** Settled: over, or needing nothing more. */
export function isSettled(signal: HistorySignal): signal is HistoryEnding {
  return signal !== "running" && signal !== "needsYou";
}

/** The word a count chip, the filter and a day's line use for a meaning (HistoryTimeline.countLabel). */
export function historyEndingLabel(signal: HistorySignal, count = 1): string {
  switch (signal) {
    case "done":
      return "Done";
    case "failed":
      return "Stopped";
    case "attention":
      return "Ended";
    case "message":
      return count === 1 ? "Message" : "Messages";
    case "running":
      return "Running";
    case "needsYou":
      return "Needs you";
  }
}

export type HistoryCount = { signal: HistoryEnding; count: number };

/** Rows counted by meaning, in display order, leaving out meanings with none and anything not settled. */
export function historyCounts(signals: Iterable<HistorySignal>): HistoryCount[] {
  const counts = new Map<HistorySignal, number>();
  for (const signal of signals) if (isSettled(signal)) counts.set(signal, (counts.get(signal) ?? 0) + 1);
  return HISTORY_ENDINGS.flatMap((signal) => {
    const count = counts.get(signal) ?? 0;
    return count > 0 ? [{ signal, count }] : [];
  });
}

/** "3 done · 1 stopped · 2 messages": an earlier day's line under its name. */
export function historyCountsLine(counts: readonly HistoryCount[]): string {
  return counts.map(({ signal, count }) => `${count} ${historyEndingLabel(signal, count).toLowerCase()}`).join(" · ");
}

/** "4h 12m", "12m", "3h"; null under a minute (HistoryRowProjection.agentTimeLabel). */
export function spanLabel(seconds: number): string | null {
  const minutes = Math.floor(seconds / 60);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** A pause between two rows worth marking on the rail: an hour or more. */
export const QUIET_GAP_MS = 3_600_000;

/** "3h 45m quiet" when the older row came an hour or more before the newer one; otherwise null. */
export function quietGap(newer: number, older: number): string | null {
  const gap = newer - older;
  if (!(gap >= QUIET_GAP_MS)) return null;
  const label = spanLabel(gap / 1000);
  return label ? `${label} quiet` : null;
}

/** The words of a row's state, as History says it (HistoryRow.Outcome.label). */
export const HISTORY_OUTCOME_LABELS = {
  running: "Running",
  done: "Done",
  stopped: "Stopped",
  expired: "Expired",
  ended: "Ended",
  replaced: "Replaced",
  "needs-you": "Needs you",
  unanswered: "No answer",
} as const;

/** What the owner's answer to a question reads as on its row's pill. */
export function answerPillText(state: string, chosenLabel?: string | null): string {
  switch (state) {
    case "pending":
      return "Waiting for you";
    case "approved":
      return "You approved";
    case "denied":
      return "You declined";
    case "yes":
      return "You said yes";
    case "no":
      return "You said no";
    case "replied":
    case "responded":
      return chosenLabel ? `You chose ${chosenLabel}` : "You replied";
    case "canceled":
      return "Withdrawn";
    default:
      return "No answer in time";
  }
}
