/**
 * The Now header's own state and geometry, ported from the iPhone's hero (ReloNowHero, ReloHUDModule)
 * and the boards (docs/internal/ui-studies/now-header-study S1, Z2). Pure mappings, tested without a DOM.
 *
 * `HeaderState` is Now-only. The orb keeps the shared `DeckState` (lib/orb-theme.ts) and its palette;
 * this decides only what surrounds it: the wash, the centre, the gauge, the satellites.
 *
 * Geometry is in the board's 390-unit frame, centred on (195, 195); the CSS scales it with the stage
 * (`--u`, now.css). The orb's radius there is ORB_R.
 */
import type { SessionRow } from "@relo/notification-contracts"

import { groupSessionRows } from "@/features/inbox/sessions-model"

export type HeaderState = "needs" | "turn" | "running" | "quiet" | "clear" | "offline" | "connecting"

/** The state's priority: connecting while there is no summary, offline from the failed refetch, then what needs the owner. */
export function headerState(input: {
  connecting: boolean
  offline: boolean
  needsYou: number
  waiting: number
  running: number
  /** Sessions working now (the server's sessions view). */
  sessionsWorking?: number
  /** Every non-idle session. */
  sessionsLive: number
}): HeaderState {
  if (input.connecting) return "connecting"
  if (input.offline) return "offline"
  if (input.needsYou > 0) return "needs"
  if (input.waiting > 0) return "turn"
  if (input.running > 0 || (input.sessionsWorking ?? 0) > 0) return "running"
  if (input.sessionsLive > 0) return "quiet"
  return "clear"
}

export const HEADER_COLOR = {
  needs: "#FF8A3D",
  turn: "#FBBF24",
  running: "#5CE1FF",
  sessions: "#A99EFF",
  slate: "#94A3B8",
  clear: "#7FA9FF",
  mute: "#98A2B6",
} as const

type RGB = readonly [number, number, number]
export type HeaderLook = {
  /** The accent: the centre's plate and glow. */
  accent: string
  /** The count's gradient end. */
  ramp: string
  /** The wash's colour (differs from the accent in clear, quiet and connecting), its three stop alphas and its breath. */
  wash: { rgb: RGB; alpha: readonly [number, number, number]; period: string }
  /** Three drifting blobs and their opacity. */
  blobs: readonly [string, string, string]
  blobAlpha: number
  /** The centre glow's period. */
  glowPeriod: string
}

export const HEADER_LOOK: Readonly<Record<HeaderState, HeaderLook>> = {
  needs: { accent: "#FF8A3D", ramp: "#FF6B57", wash: { rgb: [255, 138, 61], alpha: [0.4, 0.17, 0.035], period: "1.8s" }, blobs: ["#FF7A66", "#FF8A3D", "#8B7CFF"], blobAlpha: 0.2, glowPeriod: "1.8s" },
  turn: { accent: "#FBBF24", ramp: "#F59E0B", wash: { rgb: [251, 191, 36], alpha: [0.3, 0.12, 0.03], period: "2.1s" }, blobs: ["#FBBF24", "#FF7A66", "#8B7CFF"], blobAlpha: 0.16, glowPeriod: "2.1s" },
  running: { accent: "#5CE1FF", ramp: "#4D8DFF", wash: { rgb: [92, 225, 255], alpha: [0.28, 0.11, 0.03], period: "1.75s" }, blobs: ["#8B7CFF", "#38BDF8", "#34D399"], blobAlpha: 0.16, glowPeriod: "3.6s" },
  quiet: { accent: "#A99EFF", ramp: "#8B7CFF", wash: { rgb: [139, 124, 255], alpha: [0.22, 0.09, 0.02], period: "3.5s" }, blobs: ["#8B7CFF", "#4D8DFF", "#94A3B8"], blobAlpha: 0.13, glowPeriod: "3.6s" },
  clear: { accent: "#7FA9FF", ramp: "#7FA9FF", wash: { rgb: [77, 141, 255], alpha: [0.14, 0.06, 0.015], period: "7s" }, blobs: ["#4D8DFF", "#8B7CFF", "#38BDF8"], blobAlpha: 0.08, glowPeriod: "3.6s" },
  offline: { accent: "#98A2B6", ramp: "#98A2B6", wash: { rgb: [148, 163, 184], alpha: [0.1, 0.04, 0.01], period: "7s" }, blobs: ["#334155", "#1E293B", "#334155"], blobAlpha: 0.2, glowPeriod: "3.6s" },
  connecting: { accent: "#98A2B6", ramp: "#98A2B6", wash: { rgb: [77, 141, 255], alpha: [0.1, 0.04, 0.01], period: "1.2s" }, blobs: ["#4D8DFF", "#8B7CFF", "#38BDF8"], blobAlpha: 0.06, glowPeriod: "3.6s" },
}

/** The CSS variables a deck sets from its state (the wash, the accent, the glow). */
export function headerVars(state: HeaderState): Record<string, string> {
  const look = HEADER_LOOK[state]
  const [r, g, b] = look.wash.rgb
  const [a, bb, c] = look.wash.alpha
  return {
    "--acc": look.accent,
    "--wa": `rgb(${r} ${g} ${b} / ${a})`,
    "--wb": `rgb(${r} ${g} ${b} / ${bb})`,
    "--wc": `rgb(${r} ${g} ${b} / ${c})`,
    "--wp": look.wash.period,
    "--centre-period": look.glowPeriod,
    "--blob-1": look.blobs[0],
    "--blob-2": look.blobs[1],
    "--blob-3": look.blobs[2],
    "--blob-o": String(look.blobAlpha),
  }
}

/** The centre: a count over a plate, or the wordmark over a plate. */
export type HeaderCentre =
  | { kind: "count"; value: number; label: string }
  | { kind: "word"; label: string }

export function headerCentre(
  state: HeaderState,
  n: { needsYou: number; waiting: number; running: number; sessionsWorking: number; sessionsLive: number }
): HeaderCentre {
  switch (state) {
    case "needs":
      return { kind: "count", value: n.needsYou, label: "Needs you" }
    case "turn":
      return { kind: "count", value: n.waiting, label: "Your turn" }
    case "running":
      return n.running > 0 ? { kind: "count", value: n.running, label: "Running" } : { kind: "count", value: n.sessionsWorking, label: "Sessions" }
    case "quiet":
      return { kind: "count", value: n.sessionsLive, label: "Sessions" }
    case "clear":
      return { kind: "word", label: "All clear" }
    case "offline":
      return { kind: "word", label: "Offline" }
    case "connecting":
      return { kind: "word", label: "Connecting" }
  }
}

// ---------- Gauge ring ----------

export const FRAME = 390
export const CX = 195
export const CY = 195
export const GAUGE_R = 108
export const ORBIT_R = 138
export const TICKS_R = 92
export const RUN_R = 84
/** The web core's radius in board units (the board's own is 74): about 31% of the stage's height, at the stage's scale. */
export const ORB_R = 98

const rad = (deg: number) => (deg * Math.PI) / 180
export const pointOn = (r: number, deg: number): [number, number] => [CX + r * Math.cos(rad(deg)), CY + r * Math.sin(rad(deg))]
/** An SVG arc path on a circle about the centre, clockwise from a0 to a1 (degrees). */
export function arcPath(r: number, a0: number, a1: number): string {
  const [x0, y0] = pointOn(r, a0)
  const [x1, y1] = pointOn(r, a1)
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`
}

export type GaugeKey = "needs" | "turn" | "running" | "sessions"
/** The four quadrants, clockwise from the upper left (the iPhone's order). */
export const GAUGES: readonly { key: GaugeKey; label: string; color: string; mid: number }[] = [
  { key: "needs", label: "Needs you", color: HEADER_COLOR.needs, mid: 225 },
  { key: "turn", label: "Your turn", color: HEADER_COLOR.turn, mid: 315 },
  { key: "running", label: "Running", color: HEADER_COLOR.running, mid: 45 },
  { key: "sessions", label: "Sessions", color: HEADER_COLOR.sessions, mid: 135 },
]

/** Each gauge's fill fraction: v/5 (sessions v/6), running 0.66 or the running cards' mean progress. */
export function gaugeFractions(v: { needs: number; turn: number; running: number; sessions: number }, progress: readonly (number | null)[] = []): Record<GaugeKey, number> {
  const known = progress.filter((p): p is number => p != null)
  const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0.66
  const frac = (n: number, of: number) => (n > 0 ? Math.min(n / of, 1) : 0)
  return { needs: frac(v.needs, 5), turn: frac(v.turn, 5), running: v.running > 0 ? Math.min(Math.max(mean, 0.05), 1) : 0, sessions: frac(v.sessions, 6) }
}

// ---------- Satellites and fleet ----------

export type SatPhase = "needs" | "turn" | "running" | "quiet"
const RANK: Record<SatPhase, number> = { needs: 0, turn: 1, running: 2, quiet: 3 }
export const PHASE_COLOR: Record<SatPhase, string> = { needs: HEADER_COLOR.needs, turn: HEADER_COLOR.turn, running: HEADER_COLOR.running, quiet: HEADER_COLOR.slate }

/** A session's phase on the orbit; null when it is idle or over (no satellite). */
export function satPhase(row: Pick<SessionRow, "phase" | "waitingFor" | "fold">): SatPhase | null {
  if (row.fold === "idle" || row.phase === "idle" || row.phase === "ended") return null
  if (row.phase === "waiting") return row.waitingFor === "input" ? "needs" : "turn"
  if (row.phase === "working") return "running"
  return "quiet"
}

export type Satellite = { id: string; phase: SatPhase; duration: number; delay: number }
const PERIODS = [38, 46, 52, 60]
/** One satellite per non-idle session that orbits (a your-turn session parks at 12 o'clock instead). */
export function satellitesOf(rows: readonly SessionRow[]): { orbiting: Satellite[]; parked: boolean; live: number } {
  const live = rows.map((row) => ({ row, phase: satPhase(row) })).filter((x): x is { row: SessionRow; phase: SatPhase } => x.phase !== null)
  const orbiting = live
    .map((x, i) => ({ id: x.row.id, phase: x.phase, duration: x.phase === "quiet" ? 160 : PERIODS[i % 4]!, delay: -(i * 13 + 3) }))
    .filter((s) => s.phase !== "turn")
  return { orbiting, parked: live.some((x) => x.phase === "turn"), live: live.length }
}

/** The tail's ten dots behind a satellite on the orbit: 2.6 degrees apart (quiet 1.4). */
export function tailOf(quiet: boolean): { x: number; y: number; r: number; o: number }[] {
  return Array.from({ length: 10 }, (_, i) => {
    const k = i + 1
    const [x, y] = pointOn(ORBIT_R, -90 - k * (quiet ? 1.4 : 2.6))
    return { x: +x.toFixed(1), y: +y.toFixed(1), r: +(3.2 - k * 0.24).toFixed(2), o: +((1 - k / 11) * 0.55).toFixed(2) }
  })
}

export type FleetMachine = { key: string; name: string; phase: SatPhase | null; harnesses: { tool: "claude" | "codex" | "other"; count: number }[] }
const toolOf = (source: string | null): "claude" | "codex" | "other" => (source?.toLowerCase().startsWith("claude") ? "claude" : source?.toLowerCase() === "codex" ? "codex" : "other")

/** Per machine: its most urgent phase and its harness counts; idle machines (nothing live) have no phase. */
export function fleetOf(rows: readonly SessionRow[]): FleetMachine[] {
  return groupSessionRows(rows).map((group) => {
    const live = group.rows.map((row) => ({ row, phase: satPhase(row) })).filter((x): x is { row: SessionRow; phase: SatPhase } => x.phase !== null)
    const counts = new Map<"claude" | "codex" | "other", number>()
    for (const { row } of live) counts.set(toolOf(row.source), (counts.get(toolOf(row.source)) ?? 0) + 1)
    const top = live.map((x) => x.phase).sort((a, b) => RANK[a] - RANK[b])[0] ?? null
    return { key: group.key, name: group.label, phase: top, harnesses: [...counts].map(([tool, count]) => ({ tool, count })) }
  })
}
