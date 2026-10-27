import type { ComputerIcon, SessionRow } from "@relo/notification-contracts"

import { hashSlot } from "@/features/inbox/activity-model"
import { displayNameOrNull, sessionTitle } from "@/lib/encrypted"
import { projectColor } from "@/lib/project-palette"
import type { WorkTone } from "@/lib/work-outcome"

/**
 * Sessions on Now, as the server derived them: phase, fold and order come from the server's
 * sessions view. This module only labels rows; it never computes a phase or a window.
 */

export type { SessionRow }

const SOURCE_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  "gemini-cli": "Gemini CLI",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  "claude-desktop": "Claude Desktop",
  copilot: "GitHub Copilot",
  vscode: "VS Code",
  amp: "Amp",
  aider: "Aider",
}

/** "claude-code" -> "Claude Code"; an unknown source shows as reported. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source.toLowerCase()] ?? source
}

/** The computer's display name, or "Unknown computer". */
export function sessionGroupLabel(row: Pick<SessionRow, "computer">): string {
  return displayNameOrNull(row.computer) ?? "Unknown computer"
}

/** The mark before a session's standing (a hand when it is the owner's turn), as on the work cards. */
export type SessionIcon = "working" | "turn" | "input" | "idle" | "ended" | "unobserved"

export type SessionRowView = {
  /** The tool as reported ("Claude Code"), drawn as its logo when it has one. */
  tool: string
  project: string | null
  /** The session's own name, when this linked browser opened it; shown after the project. */
  name: string | null
  /** The session's own name when the server sends one; else its tool ("Claude Code"). */
  title: string
  /** Where it runs, after the title: "tool · project" for a named session, else the project. */
  context: string | null
  /** The project's own colour, when the context is a project. */
  projectColor: string | null
  /** "Working", "Your turn", "Needs your input", "Idle", "Ended" or "Last seen 4 min ago", in its tone. */
  standing: { label: string; tone: WorkTone; icon: SessionIcon }
  /** When the session was last seen, closing the standing line ("Working · 11:42"); null without hooks. */
  lastSeenAt: string | null
  /** The row's heading: the session's own name, else "tool · project" (iOS NowSessionInput.title). */
  heading: string
  /** The phase chip: NEEDS YOU, YOUR TURN, WORKING, otherwise slate (idle, ended, last seen). */
  chip: { label: string; tone: SessionChipTone; working: boolean }
  /** The context window and cost under the heading ("62% · $1.84"); null when the CLI reported neither. */
  usage: { pct: number | null; cost: string | null; heavy: boolean } | null
}

export type SessionChipTone = "needs" | "turn" | "working" | "slate"

/** From this share of the context window the bar and the number turn amber (iOS SessionUsage.isHeavy). */
export const HEAVY_CONTEXT_PCT = 80

/** Row words from the server's phase (iOS sessionsBlock). `relative` formats lastSeenAt. */
export function sessionRowView(row: SessionRow & { name?: string | null }, relative: (iso: string) => string): SessionRowView {
  const tool = row.source ? sourceLabel(row.source) : "Session"
  const project = displayNameOrNull(row.project)
  const name = row.name?.trim() || sessionTitle(row.id)
  const title = name ?? tool
  const context = name ? [tool, project].filter(Boolean).join(" · ") : project
  const projectColorOf = !name && project ? projectColor(hashSlot(project)) : null
  const heading = name ?? ([tool, project].filter(Boolean).join(" · ") || tool)
  const pct = typeof row.contextPct === "number" ? Math.min(Math.max(row.contextPct, 0), 100) : null
  const cost = typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0 ? `$${row.costUsd.toFixed(2)}` : null
  const usage = pct !== null || cost !== null ? { pct, cost, heavy: pct !== null && pct >= HEAVY_CONTEXT_PCT } : null
  const base = { tool, project, name, title, heading, context, projectColor: projectColorOf, lastSeenAt: row.lastSeenAt, usage }
  const chip = (label: string, tone: SessionChipTone, working = false) => ({ label, tone, working })
  switch (row.phase) {
    case "working":
      return { ...base, standing: { label: "Working", tone: "cyan", icon: "working" as const }, chip: chip("Working", "working", true) }
    case "waiting": {
      const input = row.waitingFor === "input"
      return {
        ...base,
        standing: { label: input ? "Needs your input" : "Your turn", tone: "yellow", icon: input ? ("input" as const) : ("turn" as const) },
        chip: input ? chip("Needs you", "needs") : chip("Your turn", "turn"),
      }
    }
    case "idle":
      return { ...base, standing: { label: "Idle", tone: "neutral", icon: "idle" as const }, chip: chip("Idle", "slate") }
    case "ended":
      return { ...base, standing: { label: "Ended", tone: "neutral", icon: "ended" as const }, chip: chip("Ended", "slate") }
    default: {
      const label = `Last seen ${relative(row.lastSeenAt)}`
      return { ...base, lastSeenAt: null, standing: { label, tone: "neutral", icon: "unobserved" as const }, chip: chip(label, "slate") }
    }
  }
}

export type SessionGroup = { key: string; label: string; icon: ComputerIcon | null; rows: SessionRow[]; idle: SessionRow[] }

/** Rows grouped by computer, in the server's order of first appearance; idle rows fold per group. */
export function groupSessionRows(rows: readonly SessionRow[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const row of rows) {
    const label = sessionGroupLabel(row)
    const group = groups.get(label) ?? { key: label, label, icon: row.computerIcon ?? null, rows: [], idle: [] }
    group.icon ??= row.computerIcon ?? null
    if (row.fold === "idle") group.idle.push(row)
    else group.rows.push(row)
    groups.set(label, group)
  }
  return [...groups.values()]
}

/** What a machine's status dot, summary and header chips say (iOS NowSessionGroupModel). */
export type MachineTone = "needs" | "turn" | "working" | "slate"
export type MachineView = {
  group: SessionGroup
  /** "3 sessions · 2 need you", "1 session · running", "Idle since 4:10 PM". */
  summary: string
  /** The most urgent phase on the machine; null when it has nothing but idle sessions. */
  dot: MachineTone | null
  /** The harnesses on it with how many sessions each runs, most first. */
  harnesses: { source: string; count: number }[]
  idleOnly: boolean
}

const plural = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`

/** One machine's header facts. `clock` formats an instant ("4:10 PM"). */
export function machineView(group: SessionGroup, clock: (iso: string) => string): MachineView {
  const rows = group.rows
  const needs = rows.filter((row) => row.phase === "waiting")
  const input = needs.some((row) => row.waitingFor === "input")
  const working = rows.filter((row) => row.phase === "working").length
  let summary: string
  let dot: MachineTone | null
  if (rows.length === 0) {
    const latest = group.idle.map((row) => row.lastSeenAt).sort().at(-1)
    summary = latest ? `Idle since ${clock(latest)}` : "Idle"
    dot = null
  } else if (needs.length > 0) {
    summary = `${plural(rows.length)} \u00b7 ${needs.length} ${needs.length === 1 ? "needs" : "need"} you`
    dot = input ? "needs" : "turn"
  } else if (working > 0) {
    summary = `${plural(rows.length)} \u00b7 running`
    dot = "working"
  } else {
    summary = `${plural(rows.length)} \u00b7 quiet`
    dot = "slate"
  }
  const counts = new Map<string, number>()
  for (const row of rows) if (row.source) counts.set(row.source, (counts.get(row.source) ?? 0) + 1)
  const harnesses = [...counts].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count)
  return { group, summary, dot, harnesses, idleOnly: rows.length === 0 }
}

/** The Sessions caption's count: every session that is not folded as idle (iOS NowSessionsBlock.active). */
export function activeSessionCount(rows: readonly SessionRow[]): number {
  return rows.filter((row) => row.fold !== "idle").length
}

/** A machine on the Standing by card: its name and glyph, and whether it was seen in the last ten minutes. */
export type StandbyMachine = { key: string; name: string; icon: ComputerIcon | null; seen: boolean }

const SEEN_WITHIN_MS = 10 * 60_000

/** The computers the sessions run on, each with whether anything on it showed activity within about ten minutes of `now` (ms). */
export function standbyMachines(rows: readonly SessionRow[], now: number): StandbyMachine[] {
  return groupSessionRows(rows).map((group) => {
    const latest = [...group.rows, ...group.idle].map((row) => Date.parse(row.lastSeenAt)).filter(Number.isFinite).sort((a, b) => a - b).at(-1)
    return { key: group.key, name: group.label, icon: group.icon, seen: latest !== undefined && now - latest <= SEEN_WITHIN_MS }
  })
}
