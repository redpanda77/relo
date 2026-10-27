import { AnimatePresence, LazyMotion, animate, m } from "motion/react"
import * as React from "react"

import { AnimatedNumber } from "@/components/atoms/animated-number"
import { SyncStatus } from "@/components/molecules/sync-status"
import { NowFleet } from "@/components/organisms/now-fleet"
import { NowHud } from "@/components/organisms/now-hud"
import { NowWash } from "@/components/organisms/now-wash"
import { OrbStage, type OrbComet, type OrbComets } from "@/components/organisms/orb-stage"
import type { NowArc, NowEvent, NowEventBatch } from "@/features/inbox/now-events"
import { EASE_IN, EASE_OUT, loadMotionFeatures, usePrefersReducedMotion } from "@/lib/motion"
import type { OrbArc, OrbMotion } from "@/lib/orb-scene"
import { HEADER_LOOK, headerCentre, headerState, headerVars, satellitesOf } from "@/lib/now-header"
import { cometFor, deckState, orbTheme } from "@/lib/orb-theme"
import { SIGNAL_CSS, type NowMix } from "@/lib/signal"
import type { SessionRow } from "@relo/notification-contracts"

export type NowDeckProps = {
  /** The page title, set at the top of the deck. */
  heading: React.ReactNode
  /** @deprecated No longer shown (the centre holds the top-priority state); kept so older callers compile. */
  today?: number
  /** Sessions working now (the server's sessions view); the gauge counts every non-idle session from `sessionRows`. */
  sessions?: number
  /** The server's session rows: a satellite each, the fleet line and the SESSIONS count. */
  sessionRows?: readonly SessionRow[]
  /** No summary yet: the header says CONNECTING and every tag reads "–". */
  connecting?: boolean
  /** Work waiting on the owner's turn. */
  waiting?: number
  /** @deprecated No longer shown (the readouts are the server's live counts); kept so older callers compile. */
  done?: number
  running: number
  needsYou: number
  /** The core's steady motion, from the server's summary (`orbMotion`). */
  motion: OrbMotion
  /** Each running task's arc (moving or working quietly), oldest first. */
  arcs: readonly NowArc[]
  /** The latest refresh's moments: one comet each; needs you also jumps and bumps the centre. */
  events?: NowEventBatch
  /** What happened since the owner looked, as the page-open burst (once). */
  catchUp?: readonly NowEvent[]
  /** Today's work by meaning: lights the core's peaks. */
  mix?: NowMix
  /** When Now last synced with the server (ms), and whether the last refetch failed. */
  syncedAt?: number
  offline?: boolean
  /** A refetch is in flight. */
  syncing?: boolean
}

/** Work running quietly: a grey arc at 35%, no glint. Offline: every arc frozen at 50%. */
const ARC_QUIET = "#94a3b8"

/** A moment as its comet, from its origin. */
function cometOf(event: NowEvent): OrbComet {
  return { ...cometFor(event.kind, event.carry), id: event.id, from: event.origin }
}

/** The arcs as drawn: moving work cyan with a glint while the core moves; quiet work grey and dim. */
function stageArcs(arcs: readonly NowArc[], motion: OrbMotion): OrbArc[] {
  const offline = motion.mode === "offline"
  return arcs.map((arc) => ({
    id: arc.id,
    progress: arc.progress,
    color: arc.moving ? SIGNAL_CSS.running : ARC_QUIET,
    alpha: offline ? 0.5 : arc.moving ? 1 : 0.35,
    glint: arc.moving && motion.mode === "moving",
  }))
}

const NUMBER_IN = { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: EASE_OUT } }
const NUMBER_OUT = { opacity: 0, y: -10, scale: 0.98, transition: { duration: 0.3, ease: EASE_IN } }
const LABEL_IN = { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT, delay: 0.05 } }
const LABEL_OUT = { opacity: 0, y: -6, transition: { duration: 0.3, ease: EASE_IN } }

/**
 * Now's living deck, as on the iPhone: the Relo core with its count at the centre, a gauge ring of
 * four docked tags (NEEDS YOU, YOUR TURN, RUNNING, SESSIONS), a satellite per live session on an
 * orbit, the machines line under it, and a state wash behind it all. Beside the work it is a still
 * column; stacked above the work (phones) it is the compact deck. Today's settled work is History's.
 *
 * The header has seven states (`headerState`, lib/now-header.ts): needs you, your turn, running,
 * quiet, clear, offline, connecting. The centre holds the top-priority one; it never alternates.
 * The orb itself follows the shared `DeckState` and its palette (lib/orb-theme.ts), unchanged.
 * Every motion means something: colour says whether anything needs the owner, the steady motion how
 * much is moving, a comet that something just happened, an arc how far along each task is. When
 * something newly needs the owner the centre count bumps. Reduced motion stops every animation.
 */
export function NowDeck({
  heading,
  sessions = 0,
  sessionRows,
  connecting = false,
  waiting = 0,
  running,
  needsYou,
  motion,
  arcs,
  events,
  catchUp,
  mix = {},
  syncedAt,
  syncing = false,
  offline = false,
}: NowDeckProps) {
  const reduced = usePrefersReducedMotion()
  const rows = sessionRows ?? []
  const sessionsLive = sessionRows ? satellitesOf(rows).live : sessions
  const header = headerState({ connecting, offline, needsYou, waiting, running, sessionsWorking: sessions, sessionsLive })
  const look = HEADER_LOOK[header]
  const centre = headerCentre(header, { needsYou, waiting, running, sessionsWorking: sessions, sessionsLive })

  // A batch that brings something newly needing the owner bumps the centre count (1 -> 1.08 -> 1 on a tight spring).
  const needsBatch = events?.events.some((event) => event.kind === "needsYou") ? events.key : 0
  const centreRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const node = centreRef.current
    if (!needsBatch || !node || reduced) return
    let spring: ReturnType<typeof animate> | undefined
    const up = animate(node, { scale: 1.08 }, { duration: 0.12, ease: EASE_OUT })
    void up.then(() => {
      spring = animate(node, { scale: 1 }, { type: "spring", stiffness: 600, damping: 18 })
    })
    return () => {
      up.stop()
      spring?.stop()
    }
  }, [needsBatch, reduced])

  // The core follows the steady state (the shared palette), not the header state.
  const state = deckState(needsYou, motion)
  const mixKey = JSON.stringify(mix)
  const quiet = motion.basis === "quiet"
  const theme = React.useMemo(
    () => orbTheme(JSON.parse(mixKey) as NowMix, state, { quiet, offline }),
    [mixKey, state, quiet, offline]
  )
  const stageArcList = React.useMemo(() => stageArcs(arcs, motion), [arcs, motion])
  const comets = React.useMemo<OrbComets | undefined>(
    () => (events ? { key: events.key, comets: events.events.map(cometOf) } : undefined),
    [events]
  )
  const catchUpComets = React.useMemo(() => (catchUp ?? []).map(cometOf), [catchUp])
  const progress = React.useMemo(() => arcs.filter((arc) => arc.moving).map((arc) => arc.progress), [arcs])
  const values = connecting ? null : { needs: needsYou, turn: waiting, running, sessions: sessionsLive }
  const glowing = !reduced && header !== "offline"

  return (
    <section
      aria-label="Now overview"
      className="now-deck"
      data-now-hud
      data-state={state}
      data-header={header}
      style={headerVars(header) as React.CSSProperties}
    >
      <NowWash />
      <p className="sr-only" role="status">
        {`${sessions} ${sessions === 1 ? "session" : "sessions"} working, ${waiting} waiting on you, ${running} running, ${needsYou} need you.`}
      </p>
      <header className="now-deck-head">
        {heading}
        {syncedAt != null ? <SyncStatus syncedAt={syncedAt} syncing={syncing} failed={offline} /> : null}
      </header>

      <OrbStage
        className="now-deck-stage"
        theme={theme}
        motion={motion}
        arcs={stageArcList}
        comets={comets}
        catchUp={catchUpComets}
      >
        <LazyMotion features={loadMotionFeatures} strict>
          <div
            ref={centreRef}
            aria-hidden="true"
            className="now-deck-centre"
            data-hud-centre={centre.label}
            data-live={glowing || undefined}
            data-urgent={header === "needs" || undefined}
            style={{ ["--centre-glow" as string]: `color-mix(in srgb, ${look.accent} 55%, transparent)` }}
          >
            {/* A new centre crossfades in 450 ms: the old count lifts away, the new one rises in, its
                label a beat behind. The same centre's count rolls instead. No filter at any point: the
                glow is a painted layer behind the number (now.css). */}
            <AnimatePresence initial={false}>
              <m.span
                key={`number-${centre.label}`}
                className="now-deck-centre-number"
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={NUMBER_IN}
                exit={NUMBER_OUT}
              >
                {centre.kind === "count" ? (
                  <span
                    className="hud-number numeral leading-none"
                    style={{ backgroundImage: `linear-gradient(180deg, #ffffff 0%, ${look.ramp} 100%)`, color: "transparent" }}
                  >
                    <AnimatedNumber value={centre.value} />
                  </span>
                ) : (
                  <span className="hud-wordmark">relo</span>
                )}
              </m.span>
            </AnimatePresence>
            <AnimatePresence initial={false}>
              <m.span
                key={`label-${centre.label}`}
                className="now-deck-centre-label mt-2 flex items-center gap-2"
                initial={{ opacity: 0, y: 6 }}
                animate={LABEL_IN}
                exit={LABEL_OUT}
              >
                <span className="hud-center" style={{ ["--tone" as string]: look.accent }}>{centre.label}</span>
              </m.span>
            </AnimatePresence>
          </div>
        </LazyMotion>
        <NowHud state={header} values={values} sessions={rows} progress={progress} />
      </OrbStage>

      <NowFleet sessions={rows} frozen={header === "offline"} />
    </section>
  )
}
