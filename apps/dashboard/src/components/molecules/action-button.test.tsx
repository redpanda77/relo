import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ActionButton, SUCCESS_HOLD_MS } from "@/components/molecules/action-button"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function view(props: Partial<React.ComponentProps<typeof ActionButton>>) {
  return (
    <ActionButton pendingLabel="Saving…" successLabel="Saved" {...props}>
      Save policy
    </ActionButton>
  )
}

describe("ActionButton", () => {
  it("rests with its label and no feedback", () => {
    render(view({}))
    const button = screen.getByRole("button", { name: "Save policy" })
    expect(button).toHaveAttribute("data-phase", "idle")
    expect(button).toBeEnabled()
  })

  it("names itself by the work while pending, disabled and busy, keeping the label for its width", () => {
    render(view({ pending: true }))
    const button = screen.getByRole("button", { name: "Saving…" })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("aria-busy", "true")
    expect(button).toHaveAttribute("data-phase", "pending")
    // The resting label stays in flow (hidden from assistive technology) so the width never changes.
    expect(screen.getByText("Save policy").closest("[aria-hidden='true']")).not.toBeNull()
    expect(button.querySelector("[data-slot='spinner']")).not.toBeNull()
  })

  it("draws a check with its short label after success, then rests again", async () => {
    vi.useFakeTimers()
    const { rerender } = render(view({ pending: true }))
    rerender(view({ pending: false }))
    const button = screen.getByRole("button", { name: "Saved" })
    expect(button).toHaveAttribute("data-phase", "success")
    expect(button.querySelector("[data-slot='check-draw']")).not.toBeNull()
    expect(button.querySelector("[data-slot='action-pending']")).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUCCESS_HOLD_MS)
    })
    // The leaving layer is silent at once and gone after its exit.
    expect(screen.getByRole("button", { name: "Save policy" })).toHaveAttribute("data-phase", "idle")
    const leaving = button.querySelector("[data-slot='action-success']")
    if (leaving) expect(leaving).toHaveAttribute("aria-hidden", "true")
  })

  it("goes straight back to rest after a failure (and shakes where it can)", () => {
    const animate = vi.fn(() => ({ addEventListener: vi.fn() }))
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate })
    const { rerender } = render(view({ pending: true }))
    rerender(view({ pending: false, failed: true }))
    const button = screen.getByRole("button", { name: "Save policy" })
    expect(button).toHaveAttribute("data-phase", "idle")
    expect(button.querySelector("[data-slot='check-draw']")).toBeNull()
    expect(animate).toHaveBeenCalledTimes(1)
    expect((animate.mock.calls[0] as unknown[])[0]).toHaveLength(6)
    Reflect.deleteProperty(HTMLElement.prototype, "animate")
  })

  it("follows an explicit phase: success and error play once per change, idle never infers success", () => {
    const { rerender } = render(view({ phase: "pending" }))
    rerender(view({ phase: "idle" }))
    expect(screen.getByRole("button", { name: "Save policy" })).toHaveAttribute("data-phase", "idle")
    rerender(view({ phase: "pending" }))
    rerender(view({ phase: "success" }))
    expect(screen.getByRole("button", { name: "Saved" })).toBeInTheDocument()
  })

  it("skips the success state when it has no short label", () => {
    const { rerender } = render(view({ pending: true, successLabel: null }))
    rerender(view({ pending: false, successLabel: null }))
    expect(screen.getByRole("button", { name: "Save policy" })).toHaveAttribute("data-phase", "idle")
  })
})
