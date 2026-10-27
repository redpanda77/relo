// The Home window's Now deck, as the iPhone draws it (apps/ios/Sources/ReloApp/ReloNowHero.swift, ReloHUDModule.swift,
// ReloHoloHUD.swift, ReloHoloTheme.swift; the Dashboard's port is apps/dashboard/src/lib/now-header.ts). Pure
// mappings from the presentation to the deck's inputs, tested without a DOM. Geometry is in iPhone points in a
// 380-point frame (the CSS scales it with the stage).

import type { Presentation, Session } from "../relo/presentation"
import { runningCount, turnCount } from "./state"
import type { HomeConnection } from "./state"

/** What the header leads with (ReloHUDLead). */
export type Lead = "connecting" | "checking" | "offline" | "needsYou" | "yourTurn" | "running" | "quiet" | "clear"

export const HOLO = {
  orange: "#ff8a3d",
  amber: "#fbbf24",
  cyan: "#5ce1ff",
  sessions: "#a99eff",
  slate: "#94a3b8",
  blue: "#4d8dff",
  violet: "#8b7cff",
  coral: "#ff6b57",
  azure: "#38bdf8",
  mint: "#34d399",
  sky: "#7dd3fc",
  clearAccent: "#7fa9ff",
  mute: "#98a2b6",
  ink: "#05060b",
} as const

export interface LookSpec {
  accent: string
  ramp: string
  /** The wash's colour, its strength and its breath in seconds. */
  wash: { color: string; strength: number; period: number }
  /** The aurora's three discs and their opacity. */
  aurora: { colors: [string, string, string]; strength: number }
  /** The count's glow period; null: no glow beat. */
  glowPeriod: number | null
}

/** ReloHUDLead.accent / washColor / ramp / wash / aurora / glowPeriod. */
export const LOOK: Readonly<Record<Lead, LookSpec>> = {
  needsYou: { accent: HOLO.orange, ramp: HOLO.coral, wash: { color: HOLO.orange, strength: 0.4, period: 1.8 }, aurora: { colors: [HOLO.coral, HOLO.orange, HOLO.violet], strength: 0.2 }, glowPeriod: 1.8 },
  yourTurn: { accent: HOLO.amber, ramp: "#f59e0b", wash: { color: HOLO.amber, strength: 0.3, period: 2.1 }, aurora: { colors: [HOLO.amber, HOLO.coral, HOLO.violet], strength: 0.16 }, glowPeriod: 2.1 },
  running: { accent: HOLO.cyan, ramp: HOLO.blue, wash: { color: HOLO.cyan, strength: 0.28, period: 1.75 }, aurora: { colors: [HOLO.violet, HOLO.azure, HOLO.mint], strength: 0.16 }, glowPeriod: 3.6 },
  quiet: { accent: HOLO.sessions, ramp: HOLO.violet, wash: { color: HOLO.violet, strength: 0.22, period: 3.5 }, aurora: { colors: [HOLO.violet, HOLO.blue, HOLO.slate], strength: 0.13 }, glowPeriod: 3.6 },
  clear: { accent: HOLO.clearAccent, ramp: HOLO.clearAccent, wash: { color: HOLO.blue, strength: 0.14, period: 7 }, aurora: { colors: [HOLO.blue, HOLO.violet, HOLO.azure], strength: 0.08 }, glowPeriod: null },
  offline: { accent: HOLO.slate, ramp: HOLO.slate, wash: { color: HOLO.slate, strength: 0.1, period: 7 }, aurora: { colors: [HOLO.slate, HOLO.slate, HOLO.slate], strength: 0.06 }, glowPeriod: null },
  connecting: { accent: HOLO.slate, ramp: HOLO.slate, wash: { color: HOLO.blue, strength: 0.1, period: 1.2 }, aurora: { colors: [HOLO.blue, HOLO.violet, HOLO.azure], strength: 0.06 }, glowPeriod: null },
  checking: { accent: HOLO.slate, ramp: HOLO.slate, wash: { color: HOLO.blue, strength: 0.1, period: 1.2 }, aurora: { colors: [HOLO.blue, HOLO.violet, HOLO.azure], strength: 0.06 }, glowPeriod: null },
}

export type SatPhase = "needsYou" | "yourTurn" | "running" | "quiet"
export const PHASE_COLOR: Record<SatPhase, string> = { needsYou: HOLO.orange, yourTurn: HOLO.amber, running: HOLO.cyan, quiet: HOLO.slate }
const RANK: Record<SatPhase, number> = { needsYou: 0, yourTurn: 1, running: 2, quiet: 3 }

/** A session as the header sees it (ReloHUDSession.make): waiting on input needs the owner, waiting on a turn is the owner's
 *  turn, working on a card runs, working without one is quiet. Idle, ended and untracked sessions are not drawn. */
export function satPhase(s: Pick<Session, "phase" | "waitingFor" | "hasCard">): SatPhase | null {
  if (s.phase === "waiting") return s.waitingFor === "input" ? "needsYou" : "yourTurn"
  if (s.phase === "working") return s.hasCard ? "running" : "quiet"
  return null
}

export interface DeckSession {
  id: string
  phase: SatPhase
  computer: string
  source: string | null
}

export function deckSessions(p: Presentation): DeckSession[] {
  return p.sessions.flatMap((s) => {
    const phase = satPhase(s)
    return phase ? [{ id: s.id, phase, computer: s.computer ?? "This computer", source: s.source }] : []
  })
}

export interface FleetMachine {
  name: string
  lead: SatPhase
  idle: boolean
  harnesses: { source: string; count: number }[]
}

/** ReloFleetMachine.fleet: machines with sessions at work, then the idle ones. */
export function fleetOf(sessions: DeckSession[], idleNames: string[] = []): FleetMachine[] {
  const order: string[] = []
  const groups = new Map<string, DeckSession[]>()
  for (const s of sessions) {
    if (!groups.has(s.computer)) order.push(s.computer)
    groups.set(s.computer, [...(groups.get(s.computer) ?? []), s])
  }
  const machines = order.map((name): FleetMachine => {
    const mine = groups.get(name) ?? []
    const counts = new Map<string, number>()
    for (const s of mine) counts.set(s.source ?? "agent", (counts.get(s.source ?? "agent") ?? 0) + 1)
    return { name, idle: false, lead: mine.map((s) => s.phase).sort((a, b) => RANK[a] - RANK[b])[0] ?? "quiet", harnesses: [...counts].map(([source, count]) => ({ source, count })) }
  })
  for (const name of idleNames) if (!machines.some((m) => m.name === name)) machines.push({ name, idle: true, lead: "quiet", harnesses: [] })
  return machines
}

/** Machines whose sessions are none at work (idle or ended only), listed dim on the machines line. */
export function idleMachineNames(p: Presentation, working: DeckSession[]): string[] {
  const busy = new Set(working.map((s) => s.computer))
  const names: string[] = []
  for (const s of p.sessions) {
    const name = s.computer ?? "This computer"
    if (s.phase !== "ended" && !busy.has(name) && !names.includes(name)) names.push(name)
  }
  return names
}

export interface DeckInput {
  connection: HomeConnection
  /** Epoch ms of the last update; null until the first. */
  lastUpdated: number | null
  needsYou: number
  waiting: number
  running: number
  sessionCount: number
}

export function deckInput(p: Presentation, connection: HomeConnection, lastUpdated: number | null): DeckInput {
  const sessions = deckSessions(p)
  return { connection, lastUpdated, needsYou: p.needsYouCount, waiting: turnCount(p), running: runningCount(p), sessionCount: sessions.length }
}

/** ReloNowHero.lead. */
export function leadOf(d: DeckInput): Lead {
  if (d.connection === "offline") return "offline"
  if (d.connection === "starting" || d.connection === "connecting" || d.lastUpdated === null) return "connecting"
  if (d.needsYou > 0) return "needsYou"
  if (d.waiting > 0) return "yourTurn"
  if (d.running > 0) return "running"
  return d.sessionCount > 0 ? "quiet" : "clear"
}

/** The orb's state ("as it always was"): needs you or your turn over anything live, else calm. */
export function orbMoodOf(d: DeckInput): "needsYou" | "running" | "clear" {
  if (d.needsYou > 0 || d.waiting > 0) return "needsYou"
  return d.running > 0 || d.sessionCount > 0 ? "running" : "clear"
}

/** The centre: the lead's count (never alternating), or the wordmark when there is nothing to count. */
export function centreOf(lead: Lead, d: DeckInput): { value: string | null; label: string } {
  switch (lead) {
    case "connecting":
      return { value: null, label: "CONNECTING" }
    case "offline":
      return { value: null, label: "OFFLINE" }
    case "checking":
      return { value: "–", label: "CHECKING" }
    case "needsYou":
      return { value: String(d.needsYou), label: "NEEDS YOU" }
    case "yourTurn":
      return { value: String(d.waiting), label: "YOUR TURN" }
    case "running":
      return { value: String(d.running), label: "RUNNING" }
    case "quiet":
      return { value: String(d.sessionCount), label: "SESSIONS" }
    case "clear":
      return { value: null, label: "ALL CLEAR" }
  }
}

export type Slot = "needsYou" | "yourTurn" | "running" | "sessions"
/** ReloHUDSlot: clockwise from the upper left; angles are SwiftUI's (clockwise from east, y down). */
export const SLOTS: readonly { slot: Slot; label: string; color: string; angle: number; leading: boolean }[] = [
  { slot: "needsYou", label: "NEEDS YOU", color: HOLO.orange, angle: 225, leading: true },
  { slot: "yourTurn", label: "YOUR TURN", color: HOLO.amber, angle: 315, leading: false },
  { slot: "running", label: "RUNNING", color: HOLO.cyan, angle: 45, leading: false },
  { slot: "sessions", label: "SESSIONS", color: HOLO.sessions, angle: 135, leading: true },
]

export interface Gauge {
  fill: number
  lit: boolean
}

/** ReloNowHero.gauges: needs and turn out of 5, sessions out of 6, running the mean progress (0.5 unknown). */
export function gaugesOf(d: DeckInput, progress: readonly number[]): Record<Slot, Gauge> {
  const mean = progress.length ? progress.reduce((a, b) => a + b, 0) / progress.length : 0.5
  return {
    needsYou: { fill: d.needsYou / 5, lit: d.needsYou > 0 },
    yourTurn: { fill: d.waiting / 5, lit: d.waiting > 0 },
    running: { fill: mean, lit: d.running > 0 },
    sessions: { fill: d.sessionCount / 6, lit: d.sessionCount > 0 },
  }
}

// ---- Geometry (ReloNowHero: gaugeRadius 128, orbitRadius 164; ReloHoloRing 256 frame; plasma orb 300 frame) ----

export const FRAME = 380
export const C = FRAME / 2
export const GAUGE_R = 128
export const ORBIT_R = 164
export const RING_OUTER = 126
export const ORB_SIZE = 300

export const pointOn = (r: number, deg: number): [number, number] => [C + r * Math.cos((deg * Math.PI) / 180), C + r * Math.sin((deg * Math.PI) / 180)]

/** SVG arc path, clockwise from a0 to a1 degrees. */
export function arcPath(r: number, a0: number, a1: number): string {
  const [x0, y0] = pointOn(r, a0)
  const [x1, y1] = pointOn(r, a1)
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

/** A stable start angle per session (ReloSatellites.seed). */
export function seedOf(id: string): number {
  let h = 5381
  for (const ch of id) h = (Math.imul(h, 33) + ch.codePointAt(0)!) & 0x7fffffff
  return h
}

/** The satellites: a period per index, quiet ones slow and grey; the first your-turn session parks at twelve o'clock. */
export function satellitesOf(sessions: DeckSession[]): { orbiting: { id: string; phase: SatPhase; period: number; start: number }[]; parked: boolean } {
  let parked = false
  const orbiting: { id: string; phase: SatPhase; period: number; start: number }[] = []
  sessions.forEach((s, i) => {
    if (s.phase === "yourTurn" && !parked) {
      parked = true
      return
    }
    orbiting.push({ id: s.id, phase: s.phase, period: s.phase === "quiet" ? 160 : [38, 46, 52, 60][i % 4]!, start: seedOf(s.id) % 360 })
  })
  return { orbiting, parked }
}

/** The tail behind a satellite: ten dots, 2.6 degrees apart (quiet 1.4). */
export function tailOf(quiet: boolean): { dx: number; r: number; o: number }[] {
  return Array.from({ length: 10 }, (_, i) => {
    const k = i + 1
    return { dx: k * (quiet ? 1.4 : 2.6), r: 3.2 - k * 0.24, o: (1 - k / 11) * 0.55 }
  })
}

/** The words a screen reader gets. */
export function deckSentence(d: DeckInput): string {
  const parts = [`${d.needsYou} need you`, `${d.waiting} waiting on you`, `${d.running} running`, `${d.sessionCount} ${d.sessionCount === 1 ? "session" : "sessions"} working`]
  return parts.join(", ")
}
