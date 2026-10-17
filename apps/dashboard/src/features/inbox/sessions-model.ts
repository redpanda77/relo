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
}

/** Row words from the server's phase (iOS sessionsBlock). `relative` formats lastSeenAt. */
export function sessionRowView(row: SessionRow & { name?: string | null }, relative: (iso: string) => string): SessionRowView {
  const tool = row.source ? sourceLabel(row.source) : "Session"
  const project = displayNameOrNull(row.project)
  const name = row.name?.trim() || sessionTitle(row.id)
  const title = name ?? tool
  const context = name ? [tool, project].filter(Boolean).join(" · ") : project
  const projectColorOf = !name && project ? projectColor(hashSlot(project)) : null
  const base = { tool, project, name, title, context, projectColor: projectColorOf, lastSeenAt: row.lastSeenAt }
  switch (row.phase) {
    case "working":
      return { ...base, standing: { label: "Working", tone: "cyan", icon: "working" as const } }
    case "waiting":
      return { ...base, standing: { label: row.waitingFor === "input" ? "Needs your input" : "Your turn", tone: "yellow", icon: row.waitingFor === "input" ? ("input" as const) : ("turn" as const) } }
    case "idle":
      return { ...base, standing: { label: "Idle", tone: "neutral", icon: "idle" as const } }
    case "ended":
      return { ...base, standing: { label: "Ended", tone: "neutral", icon: "ended" as const } }
    default:
      return { ...base, lastSeenAt: null, standing: { label: `Last seen ${relative(row.lastSeenAt)}`, tone: "neutral", icon: "unobserved" as const } }
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
