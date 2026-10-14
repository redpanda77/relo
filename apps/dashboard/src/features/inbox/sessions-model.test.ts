import { describe, expect, it } from "vitest"

import { groupSessionRows, sessionRowView, sourceLabel, type SessionRow } from "@/features/inbox/sessions-model"

function row(n: number, patch: Partial<SessionRow> = {}): SessionRow {
  return {
    id: `ags_00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    source: "claude-code",
    project: "relo",
    computer: "MacBook",
    phase: "working",
    observed: true,
    waitingFor: null,
    lastSeenAt: "2026-10-14T10:00:00Z",
    fold: null,
    workId: null,
    nextChangeAt: null,
    ...patch,
  }
}

const relative = () => "4 min ago"

describe("sessions model", () => {
  it("rows render the server phase", () => {
    expect(sourceLabel("claude-code")).toBe("Claude Code")
    expect(sessionRowView(row(1), relative)).toEqual({ title: "Claude Code · relo", chip: { label: "working", tone: "cyan" } })
    expect(sessionRowView(row(2, { phase: "waiting", waitingFor: "input" }), relative).chip.label).toBe("needs your input")
    expect(sessionRowView(row(3, { phase: "waiting", waitingFor: "turn" }), relative).chip.label).toBe("your turn")
    expect(sessionRowView(row(4, { phase: "idle" }), relative).chip.label).toBe("idle")
  })

  it("hooks off shows last seen", () => {
    expect(sessionRowView(row(5, { phase: null, observed: false, waitingFor: null }), relative).chip.label).toBe("last seen 4 min ago")
  })

  it("idle rows fold per computer, in server order", () => {
    const groups = groupSessionRows([
      row(1, { computer: "Studio" }),
      row(2),
      row(3, { phase: "idle", fold: "idle" }),
      row(4, { computer: null }),
    ])
    expect(groups.map((group) => group.label)).toEqual(["Studio", "MacBook", "Unknown computer"])
    expect(groups[1]!.rows).toHaveLength(1)
    expect(groups[1]!.idle).toHaveLength(1)
  })
})
