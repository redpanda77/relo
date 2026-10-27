// The Now header as the iPhone draws it (ReloNowHero): the plasma sphere in the middle, the instrument ring with each
// running task's progress, a gauge ring with four readouts docked on it (needs you, your turn, running, sessions), the
// sessions as satellites on an outer orbit, the count and its plate at the centre, and the machines beneath.
// The lead state's colour washes behind it (ReloStateWash). Geometry and colours are in deck.ts; this is the view.

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { PlasmaOrb } from "../relo/visual/PlasmaOrb"
import { SourceMark } from "../relo/ui/Card"
import { useSettings } from "../settings/store"
import {
  arcPath, C, centreOf, deckSentence, fleetOf, FRAME, gaugesOf, GAUGE_R, HOLO, idleMachineNames, LOOK, leadOf, ORB_SIZE, orbMoodOf, ORBIT_R,
  PHASE_COLOR, pointOn, satellitesOf, SLOTS, tailOf, deckSessions, type DeckInput, type Lead,
} from "./deck"
import { HoloRing } from "./HoloRing"
import type { Presentation } from "../relo/presentation"
import { rowProgress } from "../relo/presentation"

const style = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties

/** The stage's width in px, to size the canvases (the CSS scales everything else with container units). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(340)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 340))
    ro.observe(el)
    setWidth(el.clientWidth || 340)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

export function NowDeck({ presentation, input }: { presentation: Presentation; input: DeckInput }) {
  const { settings } = useSettings()
  const reduce = settings.reduceMotion || (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches)
  const lead = leadOf(input)
  const look = LOOK[lead]
  const offline = lead === "offline"
  const centre = centreOf(lead, input)
  const mood = orbMoodOf(input)
  const sessions = deckSessions(presentation)
  const { orbiting, parked } = satellitesOf(sessions)
  const fleet = fleetOf(sessions, idleMachineNames(presentation, sessions))
  const running = presentation.sections.find((s) => s.kind === "running")?.rows ?? []
  const progress = running.map((r) => rowProgress(r))
  const gauges = gaugesOf(input, progress.filter((p): p is number => p !== null))
  const unknown = lead === "connecting"
  const still = reduce || offline

  const [stageRef, width] = useWidth()
  const u = width / FRAME
  // The canvas is drawn at a stepped size (a new WebGL context per resize pixel would be wasteful) and scaled to fit.
  const orbPx = Math.max(96, Math.round((ORB_SIZE * u) / 24) * 24)
  const vars = style({ "--acc": look.accent, "--glow-period": look.glowPeriod ? `${look.glowPeriod}s` : "0s" })

  return (
    <section className="deck" data-lead={lead} style={vars} aria-label="Now overview">
      <p className="sr-only" role="status">{deckSentence(input)}</p>
      <div className="deck-stage" ref={stageRef} data-offline={offline ? "" : undefined} aria-hidden>
        <div className="deck-frame">
          {lead === "needsYou" && !reduce && (
            <>
              <i className="deck-pulse" />
              <i className="deck-pulse" style={{ animationDelay: "-0.9s" }} />
            </>
          )}
          <div className="deck-orb" style={{ width: `calc(${ORB_SIZE} * var(--u))`, height: `calc(${ORB_SIZE} * var(--u))` }}>
            <div style={{ width: orbPx, height: orbPx, transform: `scale(${(ORB_SIZE * u) / orbPx})`, transformOrigin: "0 0" }}>
              {/* Keyed: PlasmaOrb releases its WebGL context when its inputs change, and a canvas cannot get a lost one back. */}
              <PlasmaOrb key={`${mood}-${orbPx}-${still}`} mood={mood} size={orbPx} paused={offline} />
            </div>
          </div>
          <div className="deck-ringbox">
            <HoloRing mood={mood} progress={progress} still={still} />
          </div>
          <svg className="deck-svg" viewBox={`0 0 ${FRAME} ${FRAME}`} overflow="visible">
            {SLOTS.map(({ slot, color, angle }) => {
              const g = gauges[slot]
              const lit = !unknown && g.lit
              const half = 38 * Math.min(Math.max(g.fill, 0.04), 1)
              const tone = offline ? "rgba(148,163,184,0.6)" : color
              return (
                <g key={slot}>
                  <path d={arcPath(GAUGE_R, angle - 40, angle + 40)} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
                  {lit && (
                    <>
                      <path d={arcPath(GAUGE_R, angle - half, angle + half)} fill="none" stroke={tone} strokeOpacity="0.7" strokeWidth="4" strokeLinecap="round" style={{ filter: "blur(3px)" }} />
                      <path d={arcPath(GAUGE_R, angle - half, angle + half)} fill="none" stroke={tone} strokeWidth="3" strokeLinecap="round" />
                    </>
                  )}
                </g>
              )
            })}
            <circle cx={C} cy={C} r={ORBIT_R} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="1" />
            {orbiting.map((sat) => {
              const quiet = sat.phase === "quiet"
              const color = quiet || offline ? "rgba(148,163,184,0.6)" : PHASE_COLOR[sat.phase]
              const [hx, hy] = pointOn(ORBIT_R, -90)
              return (
                <g
                  key={sat.id}
                  className="deck-sat"
                  style={{ animationDuration: `${sat.period}s`, animationDelay: `${-((sat.start + 90) / 360) * sat.period}s`, animationPlayState: still ? "paused" : "running" }}
                >
                  {tailOf(quiet).map((d, i) => {
                    const [x, y] = pointOn(ORBIT_R, -90 - d.dx)
                    return <circle key={i} cx={x} cy={y} r={d.r} fill={color} opacity={d.o} />
                  })}
                  <circle cx={hx} cy={hy} r="7.5" fill={color} opacity="0.28" />
                  <circle cx={hx} cy={hy} r="3.8" fill={color} />
                </g>
              )
            })}
            {parked && (
              <>
                <circle className="deck-park" cx={C} cy={C - ORBIT_R} r="8" fill="none" stroke={HOLO.amber} strokeWidth="1.5" />
                <circle cx={C} cy={C - ORBIT_R} r="7.5" fill={HOLO.amber} opacity="0.3" />
                <circle cx={C} cy={C - ORBIT_R} r="4.2" fill={HOLO.amber} />
              </>
            )}
          </svg>
          <div className="deck-centre" data-glow={look.glowPeriod && !still ? "" : undefined}>
            {centre.value !== null ? (
              <span className="deck-count" style={{ backgroundImage: `linear-gradient(180deg, #fff, ${look.ramp})` }}>{centre.value}</span>
            ) : (
              <span className="deck-word">relo</span>
            )}
            <span className="deck-plate">{centre.label}</span>
          </div>
          {SLOTS.map(({ slot, label, color, angle, leading }) => {
            const [x, y] = pointOn(GAUGE_R + 6, angle)
            const g = gauges[slot]
            const lit = !unknown && g.lit && !offline
            const value = unknown ? "–" : String(slot === "needsYou" ? input.needsYou : slot === "yourTurn" ? input.waiting : slot === "running" ? input.running : input.sessionCount)
            return (
              <div
                key={slot}
                className="deck-tag"
                data-lit={lit ? "" : undefined}
                data-dim={offline && g.lit ? "" : undefined}
                data-leading={leading ? "" : undefined}
                style={style({ "--tone": color, left: `calc(${leading ? x + 16 : x - 16} * var(--u))`, top: `calc(${y} * var(--u))` })}
                title={`${label.charAt(0)}${label.slice(1).toLowerCase()}: ${value}`}
              >
                <b>{value}</b>
                <span>{label}</span>
              </div>
            )
          })}
        </div>
      </div>
      <Fleet fleet={fleet} frozen={offline} />
    </section>
  )
}

function Fleet({ fleet, frozen }: { fleet: ReturnType<typeof fleetOf>; frozen: boolean }) {
  if (fleet.length === 0) return <div className="deck-fleet" />
  return (
    <div className="deck-fleet" style={{ opacity: frozen ? 0.55 : 1 }}>
      {fleet.slice(0, 3).map((m) => {
        const dot = frozen ? "#6b7488" : m.idle ? "rgba(255,255,255,0.3)" : PHASE_COLOR[m.lead]
        return (
          <span key={m.name} className="deck-machine" title={m.name} data-idle={m.idle || frozen ? "" : undefined}>
            <i style={{ background: dot, boxShadow: frozen || m.idle ? "none" : `0 0 3px ${dot}` }} />
            <span className="deck-machine-name">{m.name}</span>
            {m.harnesses.map((h) => (
              <span key={h.source} className="deck-harness" title={`${h.source}: ${h.count}`}>
                <SourceMark name={h.source} size={10} />
                {h.count}
              </span>
            ))}
            {m.idle && <span className="deck-harness">idle</span>}
          </span>
        )
      })}
    </div>
  )
}

/** The light behind the deck (ReloStateWash): the lead's colour washing down from the top, breathing on the notch's
 *  periods, with a faint aurora drifting behind it. Pure CSS; the variables come from the lead's look. */
export function DeckWash({ lead }: { lead: Lead }) {
  const look = LOOK[lead]
  return (
    <div
      className="deck-wash"
      aria-hidden
      style={style({
        "--wash": look.wash.color,
        "--wash-a": look.wash.strength,
        "--wash-period": `${look.wash.period * 2}s`,
        "--aur-1": look.aurora.colors[0],
        "--aur-2": look.aurora.colors[1],
        "--aur-3": look.aurora.colors[2],
        "--aur-o": look.aurora.strength,
      })}
    >
      <i className="deck-wash-glow" />
      <i className="deck-aur" data-n="1" />
      <i className="deck-aur" data-n="2" />
      <i className="deck-aur" data-n="3" />
    </div>
  )
}
