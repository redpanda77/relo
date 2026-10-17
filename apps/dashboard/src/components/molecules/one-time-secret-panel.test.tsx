import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { OneTimeSecretPanel, type OneTimeSecret } from "@/components/molecules/one-time-secret-panel"

const issued: OneTimeSecret = {
  title: "One-time service secret",
  hint: "Send it in a header.",
  fields: [
    { label: "Endpoint", value: "https://relo.example.test/hooks" },
    { label: "Secret", value: "hook_secret_value", secret: true },
  ],
}

function Harness() {
  const [value, setValue] = React.useState<OneTimeSecret | null>(issued)
  return <OneTimeSecretPanel value={value} onDismiss={() => setValue(null)} />
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("OneTimeSecretPanel", () => {
  it("shows plain fields, keeps the secret off screen and copies each field", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    render(<Harness />)
    const panel = screen.getByRole("region", { name: "One-time service secret" })
    expect(within(panel).getByLabelText("Endpoint")).toHaveValue("https://relo.example.test/hooks")
    expect(panel.textContent).toContain("Relo cannot show it again")
    expect(within(panel).queryByDisplayValue("hook_secret_value")).toBeNull()
    fireEvent.click(within(panel).getByRole("button", { name: "Copy secret" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hook_secret_value"))
    expect(await within(panel).findByText("Secret copied.")).toBeTruthy()
    fireEvent.click(within(panel).getByRole("button", { name: "Copy endpoint" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://relo.example.test/hooks"))
  })

  it("reveals the secret for a manual copy when the clipboard refuses, and clears it on dismiss", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } })
    render(<Harness />)
    const panel = screen.getByRole("region", { name: "One-time service secret" })
    fireEvent.click(within(panel).getByRole("button", { name: "Copy secret" }))
    const manual = await within(panel).findByLabelText("Copy manually")
    expect(manual).toHaveValue("hook_secret_value")
    expect(manual.className).toContain("secret-reveal")
    expect(within(panel).getByText(/Select the secret below and copy it now/)).toBeTruthy()
    fireEvent.click(within(panel).getByRole("button", { name: "Dismiss and clear" }))
    await waitFor(() => expect(screen.queryByRole("region", { name: "One-time service secret" })).toBeNull())
    expect(screen.queryByDisplayValue("hook_secret_value")).toBeNull()
  })
})
