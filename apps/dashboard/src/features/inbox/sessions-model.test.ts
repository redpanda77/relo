import { describe, expect, it } from "vitest"

import { forgetNames, rememberSessionTitle } from "@/lib/encrypted"
import { activeSessionCount, groupSessionRows, machineView, sessionRowView, sourceLabel, type SessionRow } from "@/features/inbox/sessions-model"

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
    expect(sessionRowView(row(1), relative)).toMatchObject({
      title: "Claude Code",
      context: "relo",
      standing: { label: "Working", tone: "cyan", icon: "working" },
      lastSeenAt: "2026-10-14T10:00:00Z",
    })
    expect(sessionRowView(row(2, { phase: "waiting", waitingFor: "input" }), relative).standing.label).toBe("Needs your input")
    expect(sessionRowView(row(3, { phase: "waiting", waitingFor: "turn" }), relative).standing.label).toBe("Your turn")
    expect(sessionRowView(row(4, { phase: "idle" }), relative).standing.label).toBe("Idle")
  })

  it("hooks off shows last seen", () => {
    const view = sessionRowView(row(5, { phase: null, observed: false, waitingFor: null }), relative)
    expect(view.standing.label).toBe("Last seen 4 min ago")
    expect(view.lastSeenAt).toBeNull()
  })

  it("a session with a name of its own leads with it, tool and project after", () => {
    const view = sessionRowView({ ...row(6), name: "Release review" }, relative)
    expect(view).toMatchObject({ title: "Release review", name: "Release review", tool: "Claude Code", project: "relo", context: "Claude Code · relo", projectColor: null })
  })

  it("a session this linked browser has opened shows its own name, then forgets it", () => {
    rememberSessionTitle(row(7).id, "Fix the sync sheet")
    expect(sessionRowView(row(7), relative)).toMatchObject({ name: "Fix the sync sheet", title: "Fix the sync sheet", project: "relo" })
    forgetNames()
    expect(sessionRowView(row(7), relative).name).toBeNull()
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

  it("a row's chip, heading and context line (amber from 80%, cost dropped when absent)", () => {
    expect(sessionRowView(row(1, { contextPct: 62, costUsd: 1.84 }), relative)).toMatchObject({
      heading: "Claude Code \u00b7 relo",
      chip: { label: "Working", tone: "working", working: true },
      usage: { pct: 62, cost: "$1.84", heavy: false },
    })
    expect(sessionRowView(row(2, { phase: "waiting", waitingFor: "input", contextPct: 88 }), relative)).toMatchObject({
      chip: { label: "Needs you", tone: "needs", working: false },
      usage: { pct: 88, cost: null, heavy: true },
    })
    expect(sessionRowView(row(3, { phase: "waiting", waitingFor: "turn" }), relative)).toMatchObject({ chip: { label: "Your turn", tone: "turn" }, usage: null })
    expect(sessionRowView(row(4, { phase: null, observed: false }), relative).chip).toMatchObject({ label: "Last seen 4 min ago", tone: "slate" })
    expect(sessionRowView({ ...row(5), name: "Mac release" }, relative).heading).toBe("Mac release")
  })

  it("a machine: its summary, its most urgent dot and its harness counts", () => {
    const clock = () => "4:10 PM"
    const view = (rows: SessionRow[]) => machineView(groupSessionRows(rows)[0]!, clock)
    expect(view([row(1, { phase: "waiting", waitingFor: "input" }), row(2), row(3, { source: "codex" })])).toMatchObject({
      summary: "3 sessions \u00b7 1 needs you",
      dot: "needs",
      harnesses: [{ source: "claude-code", count: 2 }, { source: "codex", count: 1 }],
      idleOnly: false,
    })
    expect(view([row(1, { phase: "waiting", waitingFor: "turn" }), row(2, { phase: "waiting", waitingFor: "turn" })])).toMatchObject({ summary: "2 sessions \u00b7 2 need you", dot: "turn" })
    expect(view([row(1)])).toMatchObject({ summary: "1 session \u00b7 running", dot: "working" })
    expect(view([row(1, { phase: null })])).toMatchObject({ summary: "1 session \u00b7 quiet", dot: "slate" })
    expect(view([row(1, { phase: "idle", fold: "idle" })])).toMatchObject({ summary: "Idle since 4:10 PM", dot: null, idleOnly: true })
  })

  it("the caption counts every session that is not folded idle", () => {
    expect(activeSessionCount([row(1), row(2, { phase: "waiting", waitingFor: "turn" }), row(3, { phase: "idle", fold: "idle" })])).toBe(2)
  })
})
