// The System tab: the PC's vitals at a glance (Mac: components/System/SystemView.swift, 640x250). Three rings (CPU,
// memory, storage) with the CPU in the middle, readouts with two-minute graphs, a bar per core, network, battery and
// heat. One hue per measure. Drawn with SVG; it samples only while mounted.

import type { CSSProperties, ReactNode } from "react"
import { COLORS } from "../relo/ui/theme"
import {
  batteryGlyph,
  formatBytes,
  formatRate,
  HOT_CORE,
  LOW_BATTERY,
  memoryShare,
  percent,
  sparkPoints,
  storageShare,
  type BatteryGlyph,
  type Sample,
} from "./model"
import { useSystem } from "./useSystem"
import "./system.css"

/** The tab's own palette (vitals, not Relo states). Values from ReloNotchTheme.swift. */
export const VITAL = {
  cpu: COLORS.cyan,
  memory: COLORS.running,
  storage: COLORS.mint,
  network: "#7dd3fc",
  orange: "#ff8a3d",
  red: "#f43f5e",
  yellow: COLORS.yellow,
} as const

const vars = (color: string): CSSProperties => ({ ["--c" as string]: color })

export function SystemView() {
  const { sample, cpuHistory, memoryHistory, networkHistory } = useSystem()
  const mem = memoryShare(sample)
  const disk = storageShare(sample)
  return (
    <div className="sys">
      <Tile className="sys-rings">
        <Rings cpu={sample.cpu} memory={mem} storage={disk} />
        <div className="sys-legend">
          <Legend color={VITAL.cpu} title="CPU" value={sample.cpu} />
          <Legend color={VITAL.memory} title="Mem" value={mem} />
          <Legend color={VITAL.storage} title="Disk" value={disk} />
        </div>
      </Tile>
      <div className="sys-col sys-mid">
        <Tile>
          <Header color={VITAL.cpu} title="CPU" value={percent(sample.cpu)} detail={`${sample.cores.length} cores`} />
          <div className="sys-row">
            <Sparkline values={cpuHistory} color={VITAL.cpu} />
            <CoreBars cores={sample.cores} />
          </div>
        </Tile>
        <Tile>
          <Header color={VITAL.memory} title="Memory" value={formatBytes(sample.memoryUsed)} detail={`of ${formatBytes(sample.memoryTotal)}`} />
          <Sparkline values={memoryHistory} color={VITAL.memory} />
        </Tile>
      </div>
      <div className="sys-col sys-side">
        <Tile>
          <Header color={VITAL.storage} title="Storage" value={formatBytes(sample.storageFree)} detail="" />
          <div className="sys-grow" />
          <Meter value={disk} color={VITAL.storage} />
          <div className="sys-note">free of {formatBytes(sample.storageTotal)}</div>
        </Tile>
        <Tile>
          <div className="sys-head">
            <span className="sys-dot" style={vars(VITAL.network)} />
            <span className="sys-title">NETWORK</span>
            <span className="sys-spacer" />
            <Chips sample={sample} />
          </div>
          <div className="sys-rates">
            <span>
              <Arrow down /> {formatRate(sample.downBytesPerSecond)}
            </span>
            <span>
              <Arrow down={false} /> {formatRate(sample.upBytesPerSecond)}
            </span>
          </div>
          <Sparkline values={networkHistory} color={VITAL.network} relative />
        </Tile>
      </div>
    </div>
  )
}

function Tile({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`sys-tile ${className}`}>{children}</div>
}

function Header({ color, title, value, detail }: { color: string; title: string; value: string; detail: string }) {
  return (
    <div className="sys-head">
      <span className="sys-dot" style={vars(color)} />
      <span className="sys-title">{title.toUpperCase()}</span>
      <span className="sys-spacer" />
      <span className="sys-value">{value}</span>
      {detail && <span className="sys-detail">{detail}</span>}
    </div>
  )
}

function Legend({ color, title, value }: { color: string; title: string; value: number }) {
  return (
    <div className="sys-legend-item">
      <span className="sys-legend-value" style={{ color }}>
        {percent(value)}
      </span>
      <span className="sys-title sys-legend-title">{title.toUpperCase()}</span>
    </div>
  )
}

function Meter({ value, color }: { value: number; color: string }) {
  return (
    <div className="sys-meter" style={vars(color)}>
      <div style={{ width: `${Math.max(0.01, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}

/** Three concentric rings, CPU outermost, with the CPU share in the middle (118 x 118). */
function Rings({ cpu, memory, storage }: { cpu: number; memory: number; storage: number }) {
  return (
    <div className="sys-ring-box">
      <svg viewBox="0 0 118 118" width="118" height="118" aria-hidden>
        <Ring value={cpu} color={VITAL.cpu} inset={0} width={9} />
        <Ring value={memory} color={VITAL.memory} inset={13} width={7.5} />
        <Ring value={storage} color={VITAL.storage} inset={24} width={6} />
      </svg>
      <div className="sys-ring-center">
        <div className="sys-ring-number">{Math.round(cpu * 100)}</div>
        <div className="sys-title">CPU %</div>
      </div>
    </div>
  )
}

function Ring({ value, color, inset, width }: { value: number; color: string; inset: number; width: number }) {
  const r = 59 - inset - width / 2
  const c = 2 * Math.PI * r
  const share = Math.max(0.004, Math.min(1, value))
  return (
    <g transform="rotate(-90 59 59)">
      <circle cx="59" cy="59" r={r} fill="none" stroke={color} strokeOpacity={0.14} strokeWidth={width} />
      <circle
        className="sys-ring-arc"
        cx="59"
        cy="59"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={`${c * share} ${c}`}
        style={{ filter: `drop-shadow(0 0 4px ${color}73)` }}
      />
    </g>
  )
}

/** A line over a soft fill, newest at the right; 0..1, or scaled to its own peak with `relative`. */
function Sparkline({ values, color, relative = false }: { values: number[]; color: string; relative?: boolean }) {
  const W = 200
  const H = 40
  const pts = sparkPoints(values, W, H, relative)
  const id = `g-${color.replace("#", "")}`
  if (pts.length === 0) {
    return (
      <svg className="sys-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <rect x="0" y={H - 1} width={W} height="1" fill={color} fillOpacity={0.3} />
      </svg>
    )
  }
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
  const first = pts[0]!
  const area = `${line} L${W} ${H} L${first.x.toFixed(2)} ${H} Z`
  return (
    <svg className="sys-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity={0.35} />
          <stop offset="1" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** One bar per core, so a single busy core stands out. */
function CoreBars({ cores }: { cores: number[] }) {
  return (
    <div className="sys-cores">
      {cores.map((load, i) => (
        <div key={i} className="sys-core" style={vars(VITAL.cpu)}>
          <div style={{ height: Math.max(2, 34 * load), background: load > HOT_CORE ? VITAL.orange : VITAL.cpu }} />
        </div>
      ))}
    </div>
  )
}

function Arrow({ down }: { down: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden className="sys-arrow">
      <path d={down ? "M5 1v7M2 5.5L5 8.5l3-3" : "M5 9V2M2 4.5L5 1.5l3 3"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Battery and heat as small chips; heat shows only when the PC is warm. */
function Chips({ sample }: { sample: Sample }) {
  const level = sample.battery
  return (
    <div className="sys-chips">
      {level !== null && (
        <Chip
          glyph={<BatteryIcon glyph={batteryGlyph(level, sample.charging)} />}
          text={percent(level)}
          color={level < LOW_BATTERY && !sample.charging ? VITAL.red : COLORS.mint}
        />
      )}
      {sample.thermal === "fair" && <Chip glyph={<Thermo />} text="Warm" color={VITAL.yellow} />}
      {sample.thermal === "serious" && <Chip glyph={<Thermo />} text="Hot" color={VITAL.orange} />}
      {sample.thermal === "critical" && <Chip glyph={<Thermo />} text="Too hot" color={VITAL.red} />}
    </div>
  )
}

function Chip({ glyph, text, color }: { glyph: ReactNode; text: string; color: string }) {
  return (
    <span className="sys-chip" style={{ color, background: `${color}1f` }}>
      {glyph}
      {text}
    </span>
  )
}

const FILL: Record<BatteryGlyph, number> = { empty: 0, quarter: 0.25, half: 0.5, threeQuarters: 0.75, full: 1, charging: 1 }

function BatteryIcon({ glyph }: { glyph: BatteryGlyph }) {
  return (
    <svg width="16" height="10" viewBox="0 0 16 10" aria-hidden>
      <rect x="0.5" y="0.5" width="12.5" height="9" rx="2.2" fill="none" stroke="currentColor" strokeOpacity={0.6} />
      <rect x="14" y="3" width="1.6" height="4" rx="0.8" fill="currentColor" fillOpacity={0.6} />
      <rect x="2" y="2" width={9.5 * FILL[glyph]} height="6" rx="1" fill="currentColor" />
      {glyph === "charging" && <path d="M7.6 1.6L4.6 5.4h2.2l-.6 3 3-3.8H7.2z" fill="#08080d" />}
    </svg>
  )
}

function Thermo() {
  return (
    <svg width="9" height="11" viewBox="0 0 9 11" aria-hidden>
      <path d="M3 1.6a1.5 1.5 0 013 0v4.2a2.6 2.6 0 11-3 0z" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}
