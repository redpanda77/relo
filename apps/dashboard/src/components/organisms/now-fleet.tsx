import { fleetOf, PHASE_COLOR, type FleetMachine } from "@/lib/now-header"
import type { SessionRow } from "@relo/notification-contracts"

const GLYPH = { claude: "M6 1.2v9.6M1.2 6h9.6M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8", codex: "M6 1l4.3 2.5v5L6 11 1.7 8.5v-5z", other: "M6 2.2a3.8 3.8 0 1 0 0 7.6a3.8 3.8 0 0 0 0-7.6z" } as const
const GLYPH_COLOR = { claude: "#E8A07A", codex: "#C9CFDB", other: "#C9CFDB" } as const

function Machine({ machine, frozen }: { machine: FleetMachine; frozen: boolean }) {
  const idle = machine.phase === null
  const dot = frozen ? "#6B7488" : machine.phase ? PHASE_COLOR[machine.phase] : "rgb(255 255 255 / 0.3)"
  return (
    <span className="now-fleet-machine" data-idle={idle || undefined} style={{ opacity: frozen ? 0.55 : 1 }}>
      <span className="now-fleet-dot" style={{ background: dot, boxShadow: idle ? "none" : `0 0 6px ${dot}` }} />
      <span className="now-fleet-name" style={{ color: idle || frozen ? "#98A2B6" : "#EEF1F7" }}>{machine.name}</span>
      {machine.harnesses.map((h) => (
        <span key={h.tool} className="now-fleet-count">
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke={GLYPH_COLOR[h.tool]} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d={GLYPH[h.tool]} />
          </svg>
          {h.count}
        </span>
      ))}
      {idle ? <span className="now-fleet-count" style={{ color: "#7E889C" }}>idle</span> : null}
    </span>
  )
}

/** Under the stage: one entry per machine, its dot in its most urgent phase's colour, its harness counts; idle machines grey. */
export function NowFleet({ sessions, frozen = false }: { sessions: readonly SessionRow[]; frozen?: boolean }) {
  const machines = fleetOf(sessions)
  if (!machines.length) return null
  return (
    <div aria-hidden="true" className="now-deck-fleet">
      {machines.map((machine) => (
        <Machine key={machine.key} machine={machine} frozen={frozen} />
      ))}
    </div>
  )
}
