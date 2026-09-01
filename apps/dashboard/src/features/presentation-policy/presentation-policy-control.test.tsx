import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { PresentationPolicyControl } from "@/features/presentation-policy/presentation-policy-control"
import { systemPresentationPolicy } from "@/features/presentation-policy/types"

afterEach(cleanup)

it("saves a scoped policy and exposes the server-resolution boundary", async () => {
  const onSave = vi.fn().mockImplementation(async (policy) => ({
    policy,
    source: "client" as const,
  }))
  render(
    <PresentationPolicyControl
      scopeLabel="Codex client"
      initialPolicy={systemPresentationPolicy}
      initialSource="system"
      canInherit
      onSave={onSave}
      onReset={vi.fn()}
    />
  )

  expect(screen.getByText(/Automatic · Stable per task/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Configure" }))
  expect(screen.getByText(/server owns Live Activity appearance/))
    .toBeInTheDocument()
  expect(screen.queryByLabelText("Private activities")).not.toBeInTheDocument()

  fireEvent.change(screen.getByLabelText("Preset"), {
    target: { value: "terminal" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }))
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledWith({
      ...systemPresentationPolicy,
      preset: "terminal",
    })
  )
})
