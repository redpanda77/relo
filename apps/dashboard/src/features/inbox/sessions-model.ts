import type { SessionRow } from "@relo/notification-contracts"

import type { Tone } from "@/features/inbox/activity-model"
import { displayName, displayNameOrNull } from "@/lib/encrypted"

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

export type SessionRowView = { title: string; chip: { label: string; tone: Tone } }

/** Row title and chip from the server's phase (iOS 1.14 table). `relative` formats lastSeenAt. */
export function sessionRowView(row: SessionRow, relative: (iso: string) => string): SessionRowView {
  const source = row.source ? sourceLabel(row.source) : "Session"
  const title = row.project ? `${source} · ${displayName(row.project)}` : source
  switch (row.phase) {
    case "working":
      return { title, chip: { label: "working", tone: "cyan" } }
    case "waiting":
      return { title, chip: { label: row.waitingFor === "input" ? "needs your input" : "your turn", tone: "yellow" } }
    case "idle":
      return { title, chip: { label: "idle", tone: "neutral" } }
    case "ended":
      return { title, chip: { label: "ended", tone: "neutral" } }
    default:
      return { title, chip: { label: `last seen ${relative(row.lastSeenAt)}`, tone: "neutral" } }
  }
}

export type SessionGroup = { key: string; label: string; rows: SessionRow[]; idle: SessionRow[] }

/** Rows grouped by computer, in the server's order of first appearance; idle rows fold per group. */
export function groupSessionRows(rows: readonly SessionRow[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const row of rows) {
    const label = sessionGroupLabel(row)
    const group = groups.get(label) ?? { key: label, label, rows: [], idle: [] }
    if (row.fold === "idle") group.idle.push(row)
    else group.rows.push(row)
    groups.set(label, group)
  }
  return [...groups.values()]
}
