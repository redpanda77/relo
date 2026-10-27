// What the Home window shows and the pure rules that turn it into words. Mac source:
// components/Relo/ReloHomeView.swift (headline, subline, count chips, sync chip, orb mood, satellites).
//
// Home has no owner client. The notch page owns the connection and publishes this state with `publishHome` (on every
// change of the owner state); Rust keeps the latest one and relays it to Home as `home_state`.

import { invoke } from "@tauri-apps/api/core"
import type { NowSummary } from "@relo/notification-contracts"
import { inTauri } from "../bridge"
import { bannerText } from "../client/updatePolicy"
import { workingSessionsWithoutCards, type Presentation } from "../relo/presentation"
import { COLORS, toneColor } from "../relo/ui/theme"

export type HomeConnection = "starting" | "connecting" | "live" | "offline" | "signedOut"

export interface HomeNotice {
  id: string
  title: string
  summary: string | null
  source: string | null
  /** Epoch milliseconds. */
  createdAt: number
}

export interface HomeState {
  connection: HomeConnection
  /** Relo runs on this PC (local mode) instead of a server the owner chose. */
  local: boolean
  /** Local mode only: why there is no live data. */
  localProblem?: "starting" | "failed" | "repair" | null
  /** The server's host, shown under the sessions. */
  serverHost: string | null
  /** The Dashboard button is shown (server mode with an address). */
  dashboard: boolean
  /** Epoch milliseconds of the last update from the server. */
  lastUpdated: number | null
  /** The parsed `GET /api/now`; null until the first one. */
  summary: NowSummary | null
  /** Plain notices (`relo notify`) when no iPhone gets them. */
  notices?: HomeNotice[]
  /** The version of an update that waits (kept for older publishers; `update` is richer). */
  updateVersion?: string | null
  /** The waiting update: `ready` when it is downloaded and one restart installs it (ReloUpdateBanner). */
  update?: { version: string; ready: boolean; critical?: boolean } | null
  /** One plain line after an update ("Updated to 0.2.32"), shown once at the bottom. */
  updatedLine?: string | null
}

export const INITIAL_HOME: HomeState = { connection: "starting", local: false, serverHost: null, dashboard: false, lastUpdated: null, summary: null }

/** The notch page calls this whenever what Home shows changes. */
export function publishHome(state: HomeState): void {
  if (inTauri) void invoke("home_publish", { state }).catch(() => {})
}

// ---- Words (ReloHomeView.swift:155-174) ----

export function headline(needsYou: number, running: number): string {
  if (needsYou > 0) return needsYou === 1 ? "1 needs you" : `${needsYou} need you`
  if (running > 0) return running === 1 ? "1 running" : `${running} running`
  return "All clear"
}

/** A title worth showing: not blank. */
export const readable = (text: string | null | undefined): string | null => {
  const t = (text ?? "").trim()
  return t === "" ? null : t
}

/** One plain sentence under the headline: what leads, and whether anything waits on the owner. */
export function subline(p: Presentation, running: number): string {
  if (p.needsYouCount > 0) {
    const others = running > 0 ? (running === 1 ? " One more is running." : ` ${running} more are running.`) : ""
    return (p.needsYouCount === 1 ? "A question is waiting for you." : "Questions are waiting for you.") + others
  }
  const focus = p.focus
  const title = focus && focus.tone === "working" ? readable(focus.title) : null
  if (focus && title) {
    const { stepsDone: done, stepsTotal: total } = focus
    if (done !== null && total !== null && total > 0 && done < total) return `${title} is on step ${done + 1} of ${total}. Nothing needs you.`
    return `${title} is running. Nothing needs you.`
  }
  return "Work from your sessions and scripts shows up here and in the notch."
}

export type Mood = "needsYou" | "running" | "clear"

const count = (p: Presentation, kind: "running" | "waitingOnYou" | "recent"): number => p.sections.find((s) => s.kind === kind)?.rows.length ?? 0

export const runningCount = (p: Presentation): number => count(p, "running")
export const turnCount = (p: Presentation): number => count(p, "waitingOnYou")
export const doneCount = (p: Presentation): number => count(p, "recent")

export function moodOf(p: Presentation): Mood {
  if (p.needsYouCount > 0) return "needsYou"
  if (runningCount(p) > 0) return "running"
  return "clear"
}

export function moodColor(mood: Mood): string {
  return mood === "needsYou" ? COLORS.signalCoral : mood === "running" ? "#38bdf8" : "#4d8dff"
}

/** One satellite per live card or working session (the closed notch's orbit), at most six. */
export function satellites(p: Presentation): string[] {
  const rows = p.sections.filter((s) => s.kind === "needsYou" || s.kind === "waitingOnYou" || s.kind === "running").flatMap((s) => s.rows)
  const colors = [...rows.map((r) => toneColor(r.tone)), ...Array<string>(workingSessionsWithoutCards(p)).fill(COLORS.running)]
  return colors.slice(0, 6)
}

/** Signed in (the data view) vs. the hand-over to onboarding. */
export const isSignedIn = (s: HomeState): boolean => s.connection === "connecting" || s.connection === "live" || s.connection === "offline"

export type HomeScreen = "work" | "localProblem" | "needsSetup"

export function screenOf(s: HomeState): HomeScreen {
  const localTrouble = s.local && (s.localProblem === "failed" || s.localProblem === "repair" || s.localProblem === "starting")
  if (isSignedIn(s) && !localTrouble) return "work"
  return s.local ? "localProblem" : "needsSetup"
}

export const LOCAL_LABEL = "Relo on this PC"
const LOCAL_OFFLINE = "Relo isn't answering on this PC"
const LOCAL_STARTING = "Starting Relo…"

/** The sync chip (toolbar): "Live · 2:05 PM", "Offline · as of …", "Connecting", "Starting Relo…". */
export function syncLabel(s: HomeState, time: (ms: number) => string): string {
  const offline = s.connection === "offline"
  const offlineLabel = s.local ? LOCAL_OFFLINE : "Offline"
  if (s.lastUpdated !== null) return offline ? `${offlineLabel} · as of ${time(s.lastUpdated)}` : `Live · ${time(s.lastUpdated)}`
  return offline ? offlineLabel : s.local ? LOCAL_STARTING : "Connecting"
}

export function localProblemText(problem: HomeState["localProblem"]): { title: string; detail: string } {
  switch (problem) {
    case "failed":
      return { title: "Relo couldn't start on this PC", detail: "Try starting it again from Settings." }
    case "repair":
      return { title: "Relo needs a quick repair on this PC.", detail: "Repair it from Settings." }
    default:
      return { title: LOCAL_STARTING, detail: "This takes a moment." }
  }
}

/** The banner for a waiting update (ReloUpdater.swift:192-208): its words and the button that installs it. */
export function updateBanner(s: Pick<HomeState, "update" | "updateVersion">): { text: string; action: string; critical: boolean } | null {
  const u = s.update ?? (s.updateVersion ? { version: s.updateVersion, ready: false, critical: false } : null)
  if (!u) return null
  const text = u.critical ? "Important update" : bannerText(u.version, u.ready)
  return { text, action: u.ready ? "Restart now" : "Update", critical: !!u.critical }
}

/** What the "Check for Updates..." button says once the check ends (the banner shows an update that was found). */
export function checkResultLine(state: string, message?: string | null): string | null {
  switch (state) {
    case "none":
      return "Relo is up to date"
    case "off":
      return "Updates are off in this build"
    case "error":
      return message ? `Couldn't check for updates: ${message}` : "Couldn't check for updates"
    default:
      return null
  }
}

export const machineCountLabel = (n: number): string => (n === 1 ? "1 computer" : `${n} computers`)
export const sessionCountLabel = (n: number): string => (n === 1 ? "1 session" : `${n} sessions`)
