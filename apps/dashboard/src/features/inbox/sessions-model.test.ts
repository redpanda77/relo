import { describe, expect, it } from "vitest"

import {
  agentQuietText,
  groupSessions,
  harnessLabel,
  presenceView,
  quietDuration,
  quietMs,
  quietSessionsByCard,
  sessionElapsed,
  sessionGroupLabel,
  type AgentSession,
} from "@/features/inbox/sessions-model"

const now = new Date("2026-08-07T12:00:00Z").valueOf()
const id = (n: number) => `ags_00000000-0000-0000-0000-${String(n).padStart(12, "0")}`

function session(n: number, patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: id(n), harness: "claude-code", computer: "Studio", account: "work", project: "relo", state: "active",
    phase: "working", lastEvent: "tool", startedAt: "2026-08-07T10:47:57Z", lastEventAt: "2026-08-07T11:59:00Z", card: null, presence: "no_card", ...patch,
  }
}
const card = { id: "act_00000000-0000-0000-0000-000000000001", state: "active" as const, quietForSeconds: 840 }

describe("labels", () => {
  it("maps known harnesses and passes unknown ones through", () => {
    expect(harnessLabel("claude-code")).toBe("Claude Code")
    expect(harnessLabel("codex")).toBe("Codex")
    expect(harnessLabel("zed-agent")).toBe("zed-agent")
  })
  it("labels the group by computer and account", () => {
    expect(sessionGroupLabel({ computer: "Studio", account: "work" })).toBe("Studio · work")
    expect(sessionGroupLabel({ computer: "Studio", account: null })).toBe("Studio")
    expect(sessionGroupLabel({ computer: null, account: null })).toBe("Unknown computer")
  })
})

describe("quiet text", () => {
  it("counts on from the snapshot", () => {
    expect(quietMs(session(1, { card }), now + 60_000, now)).toBe(900_000)
    expect(quietMs(session(1), now, now)).toBeNull()
    expect(agentQuietText(quietMs(session(1, { card }), now, now)!)).toBe("agent running, no update for 14 min")
  })
  it("formats hours", () => {
    expect(quietDuration(30_000)).toBe("1 min")
    expect(quietDuration(2 * 3600_000)).toBe("2 h")
    expect(quietDuration(65 * 60_000)).toBe("1 h 5 min")
  })
  it("presence views", () => {
    expect(presenceView(session(1, { presence: "working", card }), now, now)).toEqual({ label: "working", tone: "cyan" })
    expect(presenceView(session(1, { presence: "quiet", card }), now, now)).toEqual({ label: "no update for 14 min", tone: "yellow" })
    expect(presenceView(session(1, { presence: "no_card" }), now, now).label).toBe("running, no card")
    expect(presenceView(session(1, { presence: "lost" }), now, now).tone).toBe("red")
  })
  it("shows elapsed", () => {
    expect(sessionElapsed(session(1), now)).toBe("running 1:12:03")
  })
})

describe("groupSessions", () => {
  it("hides everything without sessions", () => {
    expect(groupSessions(undefined, now)).toEqual({ live: [], liveCount: 0, workingCount: 0, idle: [], recent: [] })
  })
  it("orders working, quiet, no card within a group, groups by their best session", () => {
    const view = groupSessions(
      [
        session(1, { presence: "no_card" }),
        session(2, { presence: "quiet", card }),
        session(3, { presence: "working", card }),
        session(4, { computer: "Air", presence: "quiet", card }),
        session(5, { computer: "Zed", presence: "working", card }),
      ],
      now
    )
    expect(view.live.map((group) => group.label)).toEqual(["Studio · work", "Zed · work", "Air · work"])
    expect(view.live[0]!.sessions.map((s) => s.presence)).toEqual(["working", "quiet", "no_card"])
    expect(view.liveCount).toBe(5)
  })
  it("lists only recent ended and lost sessions, newest first", () => {
    const view = groupSessions(
      [
        session(1, { presence: "ended", state: "ended", lastEventAt: "2026-08-07T09:00:00Z" }),
        session(2, { presence: "lost", state: "lost", lastEventAt: "2026-08-07T11:00:00Z" }),
        session(3, { presence: "ended", state: "ended", lastEventAt: "2026-08-05T09:00:00Z" }),
      ],
      now
    )
    expect(view.live).toEqual([])
    expect(view.recent.map((s) => s.id)).toEqual([id(2), id(1)])
  })
  it("shows working and waiting sessions; idle ones fold away, and a finished turn turns idle after five minutes", () => {
    const view = groupSessions(
      [
        session(1, { presence: "working", card }),
        session(2, { state: "idle", lastEvent: "stop", lastEventAt: "2026-08-07T11:58:00Z" }),
        session(3, { state: "idle", lastEvent: "stop", lastEventAt: "2026-08-07T11:50:00Z" }),
        session(4, { state: "idle", lastEvent: "wait", lastEventAt: "2026-08-07T11:30:00Z" }),
        session(5, { state: "active", lastEvent: "start" }),
        session(6, { state: "idle", lastEvent: "stop", lastEventAt: "2026-08-07T04:00:00Z" }),
      ],
      now
    )
    expect(view.live.flatMap((group) => group.sessions.map((s) => s.id))).toEqual([id(1), id(2), id(4)])
    expect(view.workingCount).toBe(1)
    expect(view.idle.map((s) => s.id)).toEqual([id(5), id(3), id(6)])
    expect(presenceView(session(2, { state: "idle", lastEvent: "stop", lastEventAt: "2026-08-07T11:58:00Z" }), now, now))
      .toEqual({ label: "done, waiting for you", tone: "yellow" })
    expect(presenceView(session(4, { state: "idle", lastEvent: "wait", lastEventAt: "2026-08-07T11:30:00Z" }), now, now).label)
      .toBe("needs your input")
    expect(presenceView(session(6, { state: "idle", lastEvent: "stop", lastEventAt: "2026-08-07T04:00:00Z" }), now, now))
      .toEqual({ label: "idle 8 h", tone: "neutral" })
  })
  it("indexes quiet sessions by card", () => {
    const quiet = session(1, { presence: "quiet", card })
    const map = quietSessionsByCard([quiet, session(2, { presence: "working", card: { ...card, id: "act_x" } })])
    expect([...map.keys()]).toEqual([card.id])
  })
})
