import type { OwnerState } from "@relo/notification-contracts";

/**
 * Relo's sound set on the Lock Screen (ADR 0013, sections 1 and 3): the one place that names a cue file.
 * Every APNs alert serializer asks here, so the push's own sound and the app's in-app cue are the same
 * file. The iPhone app bundles these as `.caf`; an unknown name plays the system default, so the names
 * are safe to send before a build carries them. `sent` and `linked` are in-app moments: no push names them.
 */
export type SoundMoment = "needs_you" | "failed" | "your_turn" | "done";

const CUE_FILE: Record<SoundMoment, string> = {
  needs_you: "needs-you.caf",
  failed: "failed.caf",
  your_turn: "your-turn.caf",
  done: "done.caf",
};

/** Highest first: when one push could be several moments, the highest wins (ADR 0013, rule "one cue per batch"). */
const PRECEDENCE: readonly SoundMoment[] = ["needs_you", "failed", "your_turn", "done"];

/** What an alert with no moment of Relo's carries: the system sound (an agent-authored notice is not a moment). */
export const DEFAULT_SOUND = "default";

/** The `.caf` file for a moment (the value of `aps.sound`). */
export function cueFor(moment: SoundMoment): string {
  return CUE_FILE[moment];
}

/** The highest of several moments, or null when there are none. */
export function highestMoment(moments: readonly (SoundMoment | null)[]): SoundMoment | null {
  return PRECEDENCE.find((moment) => moments.includes(moment)) ?? null;
}

/** The moment a card's derived owner state is, if it is one (dropped, paused, moving and the rest are silent). */
export function ownerStateMoment(state: OwnerState): SoundMoment | null {
  switch (state) {
    case "needs_you": return "needs_you";
    case "failed": return "failed";
    case "waiting_on_you": return "your_turn";
    case "done": return "done";
    default: return null;
  }
}

function plain(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The moment an ordinary notification is, from what it carries: a question or approval (any interaction,
 * the "answer in Relo" fallback notices, a device, computer or browser asking for access) needs the owner;
 * a work's outcome notification is failed or done. A plain notify is none.
 */
export function noticeMoment(input: { interactionKind?: string | null; payload?: Record<string, unknown> | null }): SoundMoment | null {
  const payload = input.payload ?? {};
  const outcome = plain(payload.workOutcome)?.result;
  return highestMoment([
    input.interactionKind || Boolean(payload.answerInApp) || plain(payload.questionFallback)
      || plain(payload.deviceApproval) || plain(payload.computerApproval) || plain(payload.browserLink)
      ? "needs_you" : null,
    outcome === "failed" ? "failed" : outcome === "delivered" || outcome === "finished" ? "done" : null,
  ]);
}

/** `aps.sound` for an ordinary alert push: the moment's cue, else the system default. */
export function noticeSound(input: { interactionKind?: string | null; payload?: Record<string, unknown> | null }): string {
  const moment = noticeMoment(input);
  return moment ? cueFor(moment) : DEFAULT_SOUND;
}

/** `aps.alert.sound` for a Live Activity alert: the card's moment cue, or none (a card starting is silent). */
export function activityAlertSound(state: OwnerState | null | undefined): string | undefined {
  const moment = state ? ownerStateMoment(state) : null;
  return moment ? cueFor(moment) : undefined;
}
