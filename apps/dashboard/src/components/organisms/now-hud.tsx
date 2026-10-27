import { Readout } from "@/components/atoms/readout"
import {
  CX, CY, FRAME, GAUGES, GAUGE_R, HEADER_COLOR, ORB_R, ORBIT_R, PHASE_COLOR, RUN_R, TICKS_R,
  arcPath, gaugeFractions, satellitesOf, tailOf, type GaugeKey, type HeaderState,
} from "@/lib/now-header"
import type { SessionRow } from "@relo/notification-contracts"

const RUN_LEN = 2 * Math.PI * RUN_R
const OFFLINE_SAT = "rgb(148 163 184 / 0.5)"

/**
 * The deck's instruments around the core, in the board's 390-unit frame (scaled by the stage,
 * now.css): the gauge ring (four quadrant arcs, their pill tags docked on them), the ticks ring, the
 * running arc and its sweep, the orbit with a satellite per live session, and the needs-you pulses.
 * Everything animated is CSS (opacity, transform, dash offset) and stops under reduced motion.
 */
export function NowHud({
  state,
  values,
  sessions,
  progress,
}: {
  state: HeaderState
  /** Null while connecting: every tag reads "–". */
  values: Record<GaugeKey, number> | null
  sessions: readonly SessionRow[]
  /** The running cards' progress (null: unknown). */
  progress?: readonly (number | null)[]
}) {
  const frozen = state === "offline"
  const v = values ?? { needs: 0, turn: 0, running: 0, sessions: 0 }
  const fractions = gaugeFractions(v, progress)
  const { orbiting, parked } = satellitesOf(sessions)
  const runOn = v.running > 0
  return (
    <div aria-hidden="true" className="now-hud" data-header={state}>
      <div className="now-hud-frame">
        <svg className="now-hud-svg" viewBox={`0 0 ${FRAME} ${FRAME}`} overflow="visible">
          {state === "needs" ? (
            <>
              <circle className="now-pulse" cx={CX} cy={CY} r={ORB_R} />
              <circle className="now-pulse" cx={CX} cy={CY} r={ORB_R} style={{ animationDelay: "-0.9s" }} />
            </>
          ) : null}
          <g className="now-ticks">
            <circle cx={CX} cy={CY} r={TICKS_R} fill="none" stroke="rgb(255 255 255 / 0.16)" strokeWidth="3" strokeDasharray="1 4.8" />
          </g>
          <circle
            cx={CX} cy={CY} r={RUN_R} fill="none" stroke={HEADER_COLOR.running} strokeWidth="1.6" strokeLinecap="round"
            strokeDasharray={runOn ? `${(RUN_LEN * fractions.running).toFixed(1)} ${RUN_LEN.toFixed(1)}` : `0 ${RUN_LEN.toFixed(1)}`}
            transform={`rotate(-90 ${CX} ${CY})`}
            style={{ opacity: frozen ? 0.45 : 1, filter: "drop-shadow(0 0 4px #5CE1FF)" }}
          />
          {runOn && !frozen ? (
            <circle
              className="now-sweep" cx={CX} cy={CY} r={RUN_R} fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeDasharray="16 1000"
              transform={`rotate(-90 ${CX} ${CY})`}
              style={{ ["--sl" as string]: `-${(RUN_LEN * fractions.running - 16).toFixed(1)}`, filter: "drop-shadow(0 0 4px #fff)" }}
            />
          ) : null}
          <circle cx={CX} cy={CY} r={ORBIT_R} fill="none" stroke="rgb(255 255 255 / 0.09)" strokeWidth="1" />
          {orbiting.map((sat) => {
            const color = frozen ? OFFLINE_SAT : sat.phase === "quiet" ? "rgb(148 163 184 / 0.6)" : PHASE_COLOR[sat.phase]
            return (
              <g key={sat.id} className="now-sat" style={{ animationDuration: `${sat.duration}s`, animationDelay: `${sat.delay}s` }}>
                {tailOf(sat.phase === "quiet").map((d, i) => (
                  <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={color} opacity={d.o} />
                ))}
                <circle cx={CX} cy={CY - ORBIT_R} r="7.5" fill={color} opacity="0.28" />
                <circle cx={CX} cy={CY - ORBIT_R} r="3.8" fill={color} />
              </g>
            )
          })}
          {parked ? (
            <>
              <circle className="now-park" cx={CX} cy={CY - ORBIT_R} r="8" fill="none" stroke={HEADER_COLOR.turn} strokeWidth="1.5" />
              <circle cx={CX} cy={CY - ORBIT_R} r="7.5" fill={HEADER_COLOR.turn} opacity="0.3" />
              <circle cx={CX} cy={CY - ORBIT_R} r="4.2" fill={HEADER_COLOR.turn} />
            </>
          ) : null}
          {GAUGES.map((gauge) => {
            const lit = values !== null && v[gauge.key] > 0
            const half = 38 * fractions[gauge.key]
            const color = frozen && lit ? "#6B7488" : gauge.color
            return (
              <g key={gauge.key}>
                <path d={arcPath(GAUGE_R, gauge.mid - 40, gauge.mid + 40)} fill="none" stroke="rgb(255 255 255 / 0.1)" strokeWidth="3" />
                <path
                  d={arcPath(GAUGE_R, gauge.mid - Math.max(half, 0.01), gauge.mid + Math.max(half, 0.01))}
                  fill="none" stroke={lit ? color : "transparent"} strokeWidth="3" strokeLinecap="round"
                  style={{ filter: lit ? `drop-shadow(0 0 5px ${color})` : undefined, transition: "stroke 0.6s ease" }}
                />
              </g>
            )
          })}
        </svg>
        <div className="now-deck-readouts">
          {GAUGES.map((gauge) => (
            <Readout
              key={gauge.key}
              label={gauge.label}
              value={values === null ? "–" : v[gauge.key]}
              color={gauge.color}
              lit={values !== null && !frozen && v[gauge.key] > 0}
              dim={frozen && values !== null && v[gauge.key] > 0}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
