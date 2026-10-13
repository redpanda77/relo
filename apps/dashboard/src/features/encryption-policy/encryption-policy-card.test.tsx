import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"

import { EncryptionPolicyCard } from "@/features/encryption-policy/encryption-policy-card"
import type { EncryptionPolicyService } from "@/features/encryption-policy/encryption-policy-service"

describe("EncryptionPolicyCard", () => {
  test("shows the account's setting and asks before turning encryption off", async () => {
    const service: EncryptionPolicyService = {
      load: vi.fn(async () => ({ required: true, mode: "auto" as const })),
      save: vi.fn(async (mode) => ({ required: mode !== "off", mode })),
    }
    render(<EncryptionPolicyCard service={service} />)
    expect(await screen.findByText(/because your iPhone has published/)).toBeTruthy()

    const select = screen.getByLabelText("Require encryption")
    fireEvent.change(select, { target: { value: "on" } })
    await waitFor(() => expect(service.save).toHaveBeenCalledWith("on"))
    expect(await screen.findByText(/must seal text/)).toBeTruthy()

    fireEvent.change(select, { target: { value: "off" } })
    expect(service.save).toHaveBeenCalledTimes(1)
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }))
    await waitFor(() => expect(service.save).toHaveBeenCalledWith("off"))
    expect(await screen.findByText(/may send readable text/)).toBeTruthy()
  })

  test("renders nothing on a server without the setting", async () => {
    const service: EncryptionPolicyService = { load: vi.fn(async () => null), save: vi.fn() }
    const { container } = render(<EncryptionPolicyCard service={service} />)
    await waitFor(() => expect(service.load).toHaveBeenCalled())
    await waitFor(() => expect(container.textContent).toBe(""))
  })
})
