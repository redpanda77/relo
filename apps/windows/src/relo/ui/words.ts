// The Relo tab's words that depend on where Relo runs (the Mac's LocalMode.swift and the views that call it), pure so they
// are tested. "Local" reads "Mac" as "PC": there is no account, server, iPhone or encryption to mention.

import { LOCAL, offlineAnswer, offlineLabel, textReply, unreadable, untitled } from "../../local/words"

export { offlineAnswer, offlineLabel, textReply, unreadable, untitled }

/** The symbol of a feed that is not answering: the exclamation for Relo on this PC, the crossed wifi for a server. */
export const offlineSymbol = (local: boolean): "exclamation" | "wifiSlash" => (local ? "exclamation" : "wifiSlash")

/** The all-clear panel (ReloAllClear): what it says for an empty, connecting or offline Relo tab. */
export function allClearWords(o: { local: boolean; offline: boolean; connecting: boolean }): { title: string; detail: string } {
  const { local, offline, connecting } = o
  const title = offline ? (local ? LOCAL.notAnswering : "Relo is offline") : connecting ? (local ? LOCAL.starting : "Connecting to Relo…") : "Nothing needs you"
  const detail = offline ? `The last state stays here until ${local ? "Relo answers" : "the server answers"}.` : "Running work shows up here as it starts."
  return { title, detail }
}

/** "+N more" for a list that is cut: a server adds "· Dashboard" (it opens there), Relo on this PC opens Home. */
export const moreLine = (count: number, local: boolean): string => (local ? `+${count} more` : `+${count} more · Dashboard`)

/** The line for sealed cards this device could not open (NotchPresentation.privateEarlier): a count, never a list of "Private work". */
export const privateEarlierLine = (count: number): string => `${count} private earlier`

/** The error under a missed question's Dismiss when the server refused (ReloNotchStore: "Already answered or expired"). */
export const DISMISS_FAILED = "Already answered or expired"

/** The sign-in panel's words (ReloSignInPanel). */
export const SIGN_IN_WORDS = {
  headline: "See your agents here",
  headlineAgain: "Sign in to Relo again",
  detail: "Sign in from Relo's window; your work stays end-to-end encrypted.",
  openRelo: "Open Relo",
} as const
