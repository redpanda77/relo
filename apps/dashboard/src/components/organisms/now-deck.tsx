import { AnimatePresence, LazyMotion, animate, m } from "motion/react"
import * as React from "react"

import { AnimatedNumber } from "@/components/atoms/animated-number"
import { Readout } from "@/components/atoms/readout"
import { SpectrumBar } from "@/components/molecules/spectrum-bar"
import { SyncStatus } from "@/components/molecules/sync-status"
import { OrbStage, type OrbComet, type OrbComets } from "@/components/organisms/orb-stage"
import type { NowArc, NowEvent, NowEventBatch } from "@/features/inbox/now-events"
import { EASE_IN, EASE_OUT, loadMotionFeatures, usePrefersReducedMotion } from "@/lib/motion"
import type { OrbArc, OrbMotion } from "@/lib/orb-scene"
import { DECK_SIGNAL, cometFor, deckState, orbTheme, type DeckState } from "@/lib/orb-theme"
import { SESSIONS_CSS, SIGNAL_CSS, type NowMix } from "@/lib/signal"

export type NowDeckProps = {
  /** The page title, set at the top of the deck. */
  heading: React.ReactNode
  /** Today's finished items (the Today section's count): the centre when nothing is live. */
  today: number
  /** Sessions working now (the server's sessions view). */
  sessions?: number
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
  /** Spoken summary for assistive technology. */
  sentence: string
  /** Today's work by meaning: lights the core's peaks and the spectrum bar. */
  mix?: NowMix
  /** When Now last synced with the server (ms), and whether the last refetch failed. */
  syncedAt?: number
  offline?: boolean
  /** A refetch is in flight. */
  syncing?: boolean
  /** Today's agent time, already formatted ("4h 12m"); hidden when absent. */
  agentTime?: string | null
  /**
   * "split": the deck is its own column beside the work, so it also carries the sentence, today's
   * strip (`today`), agent time and the spectrum. "stacked" (phones, narrow windows): a compact deck
   * of the core and one row of readouts; the Today section carries the rest.
   */
  layout?: "stacked" | "split"
  /** Today's strip, shown under the readouts in the split layout. */
  todayStrip?: React.ReactNode
}

type Centre = { value: number; label: string; state: DeckState }

/** No card is live but sessions are working: the centre shows the sessions (as on the iPhone). */
function liveCentre(running: number, sessions: number): Centre {
  return running > 0 ? { value: running, label: "Running", state: "running" } : { value: sessions, label: "Sessions", state: "running" }
}

function centreFor(needsYou: number, running: number, sessions: number, today: number, phase: 0 | 1): Centre {
  const live = running > 0 || sessions > 0
  if (needsYou > 0 && live) {
    return phase === 0 ? { value: needsYou, label: "Needs you", state: "needsYou" } : liveCentre(running, sessions)
  }
  if (needsYou > 0) return { value: needsYou, label: "Needs you", state: "needsYou" }
  if (live) return liveCentre(running, sessions)
  return { value: today, label: "Today", state: "clear" }
}

/** The centre count: white at the top to the state's colour below, breathing while something is live. */
const RAMP: Record<DeckState, string> = { clear: SIGNAL_CSS.done, running: "#4d8dff", needsYou: "#ff6b57" }

/** Work running quietly: a grey arc at 35%, no glint. Offline: every arc frozen at 50%. */
const ARC_QUIET = "#8d93a8"

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

/** Each side of an alternating centre (Needs you, Running) holds this long, then crossfades. */
const HOLD_MS = 8000
const NUMBER_IN = { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: EASE_OUT } }
const NUMBER_OUT = { opacity: 0, y: -10, scale: 0.98, transition: { duration: 0.3, ease: EASE_IN } }
const LABEL_IN = { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT, delay: 0.05 } }
const LABEL_OUT = { opacity: 0, y: -6, transition: { duration: 0.3, ease: EASE_IN } }

/** The tab's visibility, live. */
function useDocumentHidden() {
  const [hidden, setHidden] = React.useState(() => typeof document !== "undefined" && document.visibilityState === "hidden")
  React.useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden")
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])
  return hidden
}

/**
 * Now's living deck, as on the iPhone: the Relo core with its count at the centre, each running
 * task's progress on the inner ring, then the four readouts (SESSIONS · WAITING · RUNNING · NEEDS
 * YOU, all from the server's summary). Beside the work (`layout="split"`) it is a still column that
 * also carries one sentence, today's strip, agent time and the spectrum; stacked above the work
 * (phones) it is compact: the core and one row of readouts.
 *
 * Every motion means something (`lib/orb-theme.ts`): colour says whether anything needs the owner,
 * the steady motion how much is moving (calm and still when nothing is), a comet that something
 * just happened (one per real server update, from where it came), an arc how far along each task
 * is. When something newly needs the owner the centre also jumps to Needs you and its count bumps.
 * The centre is still unless work moves or something needs the owner. With both Needs you and
 * Running, the centre holds each for 8 s and crossfades, pausing while hovered or the tab is hidden.
 */
export function NowDeck({
  heading,
  today,
  sessions = 0,
  waiting = 0,
  running,
  needsYou,
  motion,
  arcs,
  events,
  catchUp,
  sentence,
  mix = {},
  syncedAt,
  syncing = false,
  offline = false,
  agentTime = null,
  layout = "stacked",
  todayStrip,
}: NowDeckProps) {
  const reduced = usePrefersReducedMotion()
  const hidden = useDocumentHidden()
  const [hovered, setHovered] = React.useState(false)
  const alternates = needsYou > 0 && (running > 0 || sessions > 0) && !reduced
  const [phase, setPhase] = React.useState<0 | 1>(0)

  // A batch that brings something newly needing the owner: jump to Needs you and restart the hold.
  const needsBatch = events?.events.some((event) => event.kind === "needsYou") ? events.key : 0
  const [jumpedFor, setJumpedFor] = React.useState(needsBatch)
  if (jumpedFor !== needsBatch) {
    setJumpedFor(needsBatch)
    setPhase(0)
  }
  React.useEffect(() => {
    if (!alternates || hovered || hidden) return
    const timer = window.setTimeout(() => setPhase((value) => (value === 0 ? 1 : 0)), HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [alternates, hovered, hidden, phase, needsBatch])

  // The centre count bumps (1 → 1.08 → 1 on a tight spring) when something newly needs the owner.
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

  // The core follows the steady state, not the alternating centre, so it never flickers.
  const state = deckState(needsYou, motion)
  const centre = centreFor(needsYou, running, sessions, today, alternates ? phase : 0)
  const accent = SIGNAL_CSS[DECK_SIGNAL[centre.state]]
  const lit = centre.state !== "clear"
  // The centre breathes only while work moves or something needs the owner: still when calm or quiet.
  const live = lit && (motion.mode === "moving" || (needsYou > 0 && motion.mode !== "offline"))
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

  return (
    <section
      aria-label="Now overview"
      className="now-deck"
      data-now-hud
      data-state={state}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <p className="sr-only" role="status">
        {`${sessions} ${sessions === 1 ? "session" : "sessions"} working, ${waiting} waiting on you, ${running} running, ${needsYou} need you. ${sentence}`}
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
            data-live={(live && !reduced) || undefined}
            data-urgent={centre.state === "needsYou" || undefined}
            style={{ ["--centre-glow" as string]: `color-mix(in srgb, ${accent} 55%, transparent)` }}
          >
            {/* A new centre (Needs you <-> Running) crossfades in 450 ms: the old count lifts away, the
                new one rises in, its label a beat behind. The same centre's count rolls instead. No
                filter at any point: the glow is a painted layer behind the number (now.css). */}
            <AnimatePresence initial={false}>
              <m.span
                key={`number-${centre.label}`}
                className="now-deck-centre-number"
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={NUMBER_IN}
                exit={NUMBER_OUT}
              >
                <span
                  className="hud-number numeral text-[4.25rem] leading-none @3xl:text-[5rem]"
                  style={{
                    backgroundImage: lit ? `linear-gradient(180deg, #ffffff 0%, ${RAMP[centre.state]} 100%)` : "none",
                    color: lit ? "transparent" : "#ffffff",
                  }}
                >
                  <AnimatedNumber value={centre.value} />
                </span>
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
                <span className="hud-center" style={{ ["--tone" as string]: accent }}>{centre.label}</span>
              </m.span>
            </AnimatePresence>
          </div>
        </LazyMotion>
      </OrbStage>

      <div className="now-deck-instruments">
        <div aria-hidden="true" className="now-deck-readouts">
          <Readout label="Sessions" value={sessions} color={SESSIONS_CSS} lit={sessions > 0} />
          <Readout label="Waiting" value={waiting} color={SIGNAL_CSS.attention} lit={waiting > 0} />
          <Readout label="Running" value={running} color={SIGNAL_CSS.running} lit={running > 0} />
          <Readout label="Needs you" value={needsYou} color={SIGNAL_CSS.needsYou} lit={needsYou > 0} />
        </div>
      </div>
      {layout === "split" ? (
        <div className="now-deck-more">
          <p className="now-deck-sentence">{sentence}</p>
          {todayStrip}
          {agentTime || Object.keys(mix).length ? (
            <div className="flex flex-col gap-3">
              {agentTime ? (
                <span className="micro tabular-nums tracking-[0.1em]" data-hud-agent-time>{`Agent time ${agentTime}`}</span>
              ) : null}
              <SpectrumBar mix={mix} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
