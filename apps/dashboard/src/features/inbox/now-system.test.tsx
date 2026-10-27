import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { NowSystem } from "@/features/inbox/now-system"
import { standbyMachines } from "@/features/inbox/sessions-model"
import { washFor } from "@/lib/backdrop-wash"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("NowSystem", () => {
  it("shows the offline card with Retry, since the last good sync", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ devices: [] })))
    const retry = vi.fn()
    render(<NowSystem offline syncing={false} syncedAt={Date.parse("2026-10-24T18:37:00")} onRetry={retry} />)
    expect(screen.getByText(/^OFFLINE · SINCE/)).toBeInTheDocument()
    expect(screen.getByText("Your server is out of reach")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it("says reconnecting while a refetch is in flight after being offline", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ devices: [] })))
    render(<NowSystem offline syncing onRetry={() => {}} />)
    expect(screen.getByText("Catching up with your server")).toBeInTheDocument()
  })

  it("renders nothing while all is well", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ devices: [] })))
    const { container } = render(<NowSystem offline={false} syncing={false} onRetry={() => {}} />)
    expect(container.querySelector("[data-now-system]")).toBeNull()
  })
})

describe("washFor", () => {
  it("picks the most urgent state", () => {
    expect(washFor({ needsYou: 1, waitingOnYou: 1, running: 1 })).toBe("needsYou")
    expect(washFor({ needsYou: 0, waitingOnYou: 1, running: 1 })).toBe("yourTurn")
    expect(washFor({ needsYou: 0, waitingOnYou: 0, running: 2 })).toBe("running")
    expect(washFor({ needsYou: 0, waitingOnYou: 0, running: 0 })).toBe("clear")
    expect(washFor({ needsYou: 3, waitingOnYou: 0, running: 0 }, true)).toBe("quiet")
  })
})

describe("standbyMachines", () => {
  it("marks a machine seen within ten minutes", () => {
    const now = Date.parse("2026-10-24T12:00:00Z")
    const row = (computer: string, ago: number) =>
      ({ id: computer, computer, computerIcon: "laptop", fold: "idle", lastSeenAt: new Date(now - ago * 60_000).toISOString() }) as never
    const machines = standbyMachines([row("Studio", 3), row("Server", 120)], now)
    expect(machines.map((m) => [m.name, m.seen])).toEqual([["Studio", true], ["Server", false]])
  })
})
