import { describe, expect, it } from "vitest"

import { historyDays, todayPanel, type HistoryRowModel } from "@/features/inbox/history-model"

const row = (id: string, at: number, signal: HistoryRowModel["signal"]): HistoryRowModel =>
  ({ card: { id } as HistoryRowModel["card"], signal, glyph: "check", label: "Done", context: null, pill: null, facts: [], unreadMessage: false, at }) as HistoryRowModel

describe("History's timeline", () => {
  const now = new Date(2026, 9, 27, 15, 0).valueOf()
  const hour = 3_600_000

  it("splits rows by day, marks an hour or more between rows as quiet, and counts each day by meaning", () => {
    const days = historyDays(
      [row("a", now - 1000, "done"), row("b", now - 4 * hour, "failed"), row("c", now - 26 * hour, "message")],
      now
    )
    expect(days.map((day) => [day.isToday, day.title])).toEqual([[true, "Today"], [false, "Yesterday"]])
    expect(days[0]!.rows[0]!.gapAfter).toMatch(/^3h 59m quiet$/)
    expect(days[0]!.rows[1]!.gapAfter).toBeNull()
    expect(days[0]!.counts).toBe("1 done · 1 stopped")
    expect(days[1]!.counts).toBe("1 message")
  })

  it("counts today's panel from the server's recent rows on the browser's own day, by hour and meaning", () => {
    const panel = todayPanel(
      [
        { at: new Date(now - hour).toISOString(), signal: "done" },
        { at: new Date(now - hour).toISOString(), signal: "done" },
        { at: new Date(now - 2 * hour).toISOString(), signal: "attention" },
        { at: new Date(now - 20 * hour).toISOString(), signal: "failed" },
      ],
      now
    )
    expect(panel.total).toBe(3)
    expect(panel.counts).toEqual([{ signal: "done", count: 2 }, { signal: "attention", count: 1 }])
    expect(panel.hours[14]).toEqual({ done: 2 })
    expect(panel.maxTotal).toBe(2)
    expect(panel.currentHour).toBe(15)
  })
})
