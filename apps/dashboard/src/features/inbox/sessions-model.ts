import { clockLabel, type Tone } from "@/features/inbox/activity-model"
import type { InboxOverview } from "@/features/inbox/types"
import { displayNameOrNull } from "@/lib/encrypted"

export type AgentSession = NonNullable<InboxOverview["sessions"]>[number]
export type SessionPresence = AgentSession["presence"]

const HARNESS_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  "gemini-cli": "Gemini CLI",
  opencode: "OpenCode",
  aider: "Aider",
}

/** "claude-code" -> "Claude Code"; an unknown harness shows as reported. */
export function harnessLabel(harness: string): string {
  return HARNESS_LABELS[harness.toLowerCase()] ?? harness
}

/** "MacBook · work", whichever exist; null when neither is known. */
export function sessionGroupLabel(session: Pick<AgentSession, "computer" | "account">): string {
  const parts = [session.computer, session.account].map(displayNameOrNull).filter(Boolean)
  return parts.length ? parts.join(" · ") : "Unknown computer"
}

/** Presence order: working first, then quiet, then running without a card, then the recent. */
const PRESENCE_RANK: Record<SessionPresence, number> = { working: 0, quiet: 1, no_card: 2, lost: 3, ended: 4 }

export const isLivePresence = (presence: SessionPresence) =>
  presence === "working" || presence === "quiet" || presence === "no_card"

/** How long a session's ended/lost row stays listed. */
export const RECENT_WINDOW_MS = 24 * 60 * 60_000

/**
 * Silence of a quiet session's card now: the server's figure at the time of the snapshot plus what
 * has passed since, so the text keeps counting without a refetch.
 */
export function quietMs(session: Pick<AgentSession, "card">, now: number, syncedAt: number): number | null {
  if (!session.card) return null
  return session.card.quietForSeconds * 1000 + Math.max(0, now - syncedAt)
}

/** "14 min", "1 h 5 min". */
export function quietDuration(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
}

/** "no update for 14 min". */
export function quietText(ms: number): string {
  return `no update for ${quietDuration(ms)}`
}

/** On the card in Live now: "agent running, no update for 14 min". */
export function agentQuietText(ms: number): string {
  return `agent running, ${quietText(ms)}`
}

/** "running 1:12:03" from the session start. */
export function sessionElapsed(session: Pick<AgentSession, "startedAt">, now: number): string | null {
  const started = new Date(session.startedAt).valueOf()
  return Number.isFinite(started) ? `running ${clockLabel((now - started) / 1000)}` : null
}

export type PresenceView = { label: string; tone: Tone }

export function presenceView(session: AgentSession, now: number, syncedAt: number): PresenceView {
  switch (session.presence) {
    case "working":
      return { label: "working", tone: "cyan" }
    case "quiet": {
      const ms = quietMs(session, now, syncedAt)
      return { label: ms == null ? "quiet" : quietText(ms), tone: "yellow" }
    }
    case "no_card":
      return { label: "running, no card", tone: "neutral" }
    case "lost":
      return { label: "lost", tone: "red" }
    case "ended":
      return { label: "ended", tone: "neutral" }
  }
}

export type SessionGroup = { key: string; label: string; sessions: AgentSession[] }

export type SessionsView = {
  /** Live sessions grouped by computer · account. */
  live: SessionGroup[]
  liveCount: number
  /** Ended and lost sessions within the recent window, newest first, lost before ended on ties. */
  recent: AgentSession[]
}

function ordered(a: AgentSession, b: AgentSession): number {
  const rank = PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence]
  if (rank !== 0) return rank
  return new Date(b.lastEventAt).valueOf() - new Date(a.lastEventAt).valueOf()
}

export function groupSessions(sessions: readonly AgentSession[] | undefined, now: number): SessionsView {
  const all = sessions ?? []
  const groups = new Map<string, SessionGroup>()
  for (const session of all.filter((item) => isLivePresence(item.presence)).sort(ordered)) {
    const label = sessionGroupLabel(session)
    const group = groups.get(label) ?? { key: label, label, sessions: [] }
    group.sessions.push(session)
    groups.set(label, group)
  }
  const live = [...groups.values()].sort((a, b) => {
    const rank = PRESENCE_RANK[a.sessions[0]!.presence] - PRESENCE_RANK[b.sessions[0]!.presence]
    return rank !== 0 ? rank : a.label.localeCompare(b.label)
  })
  const recent = all
    .filter((item) => !isLivePresence(item.presence))
    .filter((item) => now - new Date(item.lastEventAt).valueOf() <= RECENT_WINDOW_MS)
    .sort((a, b) => new Date(b.lastEventAt).valueOf() - new Date(a.lastEventAt).valueOf())
  return { live, liveCount: live.reduce((n, group) => n + group.sessions.length, 0), recent }
}

/** Sessions whose card has gone quiet, by card id. */
export function quietSessionsByCard(sessions: readonly AgentSession[] | undefined): Map<string, AgentSession> {
  const map = new Map<string, AgentSession>()
  for (const session of sessions ?? []) {
    if (session.presence === "quiet" && session.card) map.set(session.card.id, session)
  }
  return map
}
