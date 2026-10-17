/**
 * What the Relo core on Now means, as pure mappings from the server's summary to the scene's inputs
 * (`lib/orb-scene.ts`), tested without WebGL. The orb has no logic of its own: every motion answers
 * one of the owner's questions, and nothing moves without a reason.
 *
 * - Colour: does anything need me (orange), is work under way (cyan), or is all clear (mint).
 * - Steady motion (plasma churn, surface displacement, ring rotation, dust): is anything moving, and
 *   how much. Nothing running is a calm, still core.
 * - Comets: something just happened (one per real server update, `features/inbox/now-events.ts`).
 * - Arcs: how far along each task is.
 */
import { DECK_LEAD, deckBasis, deckColorState, deckColors, type DeckState } from "@relo/notification-contracts"

import type { OrbMotion, OrbSignals, OrbTheme } from "@/lib/orb-scene"
import { SIGNAL_CSS, type NowMix, type Signal } from "@/lib/signal"

/** The colour state: what leads the core (shared with the server, which paints the first frame). */
export type { DeckState }

/** The leading meaning per state: mint when all is clear, cyan while work runs, orange when you are needed. */
export const DECK_SIGNAL: Readonly<Record<DeckState, Signal>> = DECK_LEAD

/** The landing's look: cyan, violet and magenta. */
export const LANDING_THEME: OrbTheme = { colors: ["#5ce1ff", "#8b7cff", "#d65cf0"] }
/**
 * The decorative stream for stages that show no owner data (sign-in, loading): six comets in every
 * meaning. Never on Now, where a comet always reports a real update.
 */
export const LANDING_SIGNALS: OrbSignals = { count: 6, colors: ["#5ce1ff", "#34d399", "#ff8a3d", "#8b7cff", "#d65cf0"] }

/**
 * Each state's plasma ramp, the quiet and offline tints and the colour state live in the shared
 * palette (`@relo/notification-contracts` orb-palette), so the server's first frame and the scene agree.
 */
export { OFFLINE_GREYING, QUIET_DESATURATION, toward } from "@relo/notification-contracts"
/** Needs you lifts the halo's brightness (urgency in colour and light, never in motion). */
export const NEEDS_YOU_GLOW = 0.15

/**
 * The core's colours: the state's ramp, today's biggest other meaning on the brightest peaks.
 * Quiet work (nothing moving) desaturates the ramp; offline greys it.
 */
export function orbTheme(mix: NowMix, state: DeckState, tint: { quiet?: boolean; offline?: boolean } = {}): OrbTheme {
  return { colors: deckColors(mix, state, tint), glow: state === "needsYou" ? NEEDS_YOU_GLOW : 0 }
}

/** The colour state from the server's needs-you count and the core's motion. */
export function deckState(needsYou: number, motion: Pick<OrbMotion, "basis">): DeckState {
  return deckColorState(needsYou, motion.basis)
}

/** What the motion level reads from the server's summary (structural, so tests can pass literals). */
type MotionSummary = {
  needsYou: readonly unknown[]
  running: readonly { owner: { state: string } }[]
  quiet: readonly { owner: { state: string } }[]
  sessions: { sessions: readonly { phase: string | null; workId: string | null }[] }
}

/** The heartbeat (lib/heartbeat.ts) and the slower quiet breath. */
const HEARTBEAT_MS = 4000
const QUIET_BREATH_MS = 8000

const CALM = { plasmaRate: 0.06, displacement: 0.01, ringSpeed: 0, dust: 0, breath: { depth: 0.35, period: HEARTBEAT_MS } }
const QUIET = { plasmaRate: 0.15, displacement: 0.012, ringSpeed: 0, dust: 0, breath: { depth: 0.5, period: QUIET_BREATH_MS } }

/**
 * How much the core moves, from the server's summary only (no client clock): the motion level
 * L = clamp((moving + 0.4 working quietly + 0.5 sessions working without a card) / 3, 0, 1).
 *
 * - calm: nothing moving, no quiet work: the plasma barely drifts, rings and dust stand still, the
 *   halo breathes shallowly on the heartbeat.
 * - moving: churn, displacement and ring speed scale with L; dust drifts; the halo breathes fully.
 * - quiet: only quiet work (working quietly, stale, not responding): a slow churn, still rings, a
 *   slower, shallower breath.
 * - offline: the last refetch failed: calm, whatever the last summary said.
 *
 * Needs you breathes fully on the heartbeat but moves no faster: urgency is colour, not alarm.
 * `basis` is the mode the summary alone gives (offline aside), for the colour.
 */
export function orbMotion(summary: MotionSummary | null, offline: boolean, extraNeedsYou = 0): OrbMotion {
  const items = summary ? [...summary.running, ...summary.quiet] : []
  const moving = items.filter((item) => item.owner.state === "moving").length
  const workingQuietly = items.filter((item) => item.owner.state === "working_quietly").length
  const sessions = summary?.sessions.sessions.filter((row) => row.phase === "working" && !row.workId).length ?? 0
  const level = Math.min(Math.max((moving + 0.4 * workingQuietly + 0.5 * sessions) / 3, 0), 1)
  const needsYou = (summary?.needsYou.length ?? 0) + extraNeedsYou > 0
  const basis: OrbMotion["basis"] = deckBasis(summary)

  if (offline) return { level: 0, mode: "offline", basis, ...CALM }
  if (basis === "moving") {
    return {
      level,
      mode: "moving",
      basis,
      plasmaRate: 0.55 + 0.9 * level,
      displacement: 0.02 + 0.015 * level,
      ringSpeed: level,
      dust: 0.012,
      breath: { depth: 1, period: HEARTBEAT_MS },
    }
  }
  const rest = basis === "quiet" ? QUIET : CALM
  return {
    level: basis === "quiet" ? level : 0,
    mode: basis,
    basis,
    ...rest,
    breath: needsYou ? { depth: 1, period: HEARTBEAT_MS } : rest.breath,
  }
}

/**
 * The motion of a stage that shows no owner data (sign-in, loading): the landing's lively core, as
 * the deck drew it before motion meant anything.
 */
export const DECORATIVE_MOTION: OrbMotion = {
  level: 1,
  mode: "moving",
  basis: "moving",
  plasmaRate: 0.55 + 0.7 * 0.9,
  displacement: 0.035,
  ringSpeed: 1,
  dust: 0.012,
  breath: { depth: 1, period: HEARTBEAT_MS },
}

/** What a comet reports (one per real server update; `features/inbox/now-events.ts`). */
export type OrbMomentKind = "needsYou" | "failed" | "done" | "started" | "recovered" | "step" | "sessionStarted" | "update"

/** A comet's look and weight: colour, head size, trail length, impact, and what it does on landing. */
export type OrbCometLook = {
  color: string
  kind: "needsYou" | "done" | "failed" | "activity"
  size: number
  trailScale: number
  impact: number
  /** On landing, the item's arc grows in (a new card) or eases forward (a step). */
  arc: "grow" | "advance" | null
}

const COMET: Record<OrbMomentKind, OrbCometLook> = {
  needsYou: { color: "#ff8a3d", kind: "needsYou", size: 1, trailScale: 1, impact: 1.6, arc: null },
  failed: { color: SIGNAL_CSS.failed.toLowerCase(), kind: "failed", size: 1, trailScale: 1, impact: 0.9, arc: null },
  done: { color: SIGNAL_CSS.done.toLowerCase(), kind: "done", size: 1, trailScale: 1, impact: 1, arc: null },
  started: { color: SIGNAL_CSS.running.toLowerCase(), kind: "activity", size: 1, trailScale: 1, impact: 1, arc: "grow" },
  recovered: { color: SIGNAL_CSS.running.toLowerCase(), kind: "activity", size: 1, trailScale: 1, impact: 0.8, arc: null },
  step: { color: SIGNAL_CSS.running.toLowerCase(), kind: "activity", size: 0.7, trailScale: 1, impact: 0.6, arc: "advance" },
  sessionStarted: { color: SIGNAL_CSS.running.toLowerCase(), kind: "activity", size: 0.7, trailScale: 1, impact: 0.5, arc: null },
  update: { color: "#bff3ff", kind: "activity", size: 0.7, trailScale: 0.5, impact: 0.4, arc: null },
}

/** The most a comet carrying a burst's remainder may hit. */
export const MAX_IMPACT = 1.6

/** A moment's comet; one that carries `carry` more moments lands harder (×(1 + 0.15·carry), capped). */
export function cometFor(kind: OrbMomentKind, carry = 0): OrbCometLook {
  const look = COMET[kind]
  if (!carry) return look
  return { ...look, impact: Math.min(look.impact * (1 + 0.15 * carry), MAX_IMPACT) }
}
