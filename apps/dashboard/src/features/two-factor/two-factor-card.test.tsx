import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"

import { TwoFactorCard } from "@/features/two-factor/two-factor-card"
import type { TwoFactorService } from "@/features/two-factor/two-factor-service"

describe("TwoFactorCard", () => {
  test("turns on with the password, a scanned code and saved backup codes; turns off with the password", async () => {
    const service: TwoFactorService = {
      status: vi.fn(async () => false),
      begin: vi.fn(async () => ({ totpURI: "otpauth://totp/Relo:owner@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Relo", backupCodes: ["aaaaa-bbbbb", "ccccc-ddddd"] })),
      confirm: vi.fn(async (code: string) => { if (code !== "123456") throw new Error("That code did not work. Check it and try again.") }),
      disable: vi.fn(async () => undefined),
      newBackupCodes: vi.fn(async () => ["eeeee-fffff"]),
    }
    render(<TwoFactorCard service={service} />)
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }))
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "unique-test-password" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(await screen.findByRole("img", { name: "Authenticator setup code" })).toBeTruthy()
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeTruthy()
    expect(service.begin).toHaveBeenCalledWith("unique-test-password")

    fireEvent.change(screen.getByLabelText("Code from the app"), { target: { value: "000000" } })
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }))
    expect(await screen.findByRole("alert")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Code from the app"), { target: { value: "123456" } })
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }))
    expect(await screen.findByText("aaaaa-bbbbb")).toBeTruthy()
    expect(screen.getByText(/needs your password and a code/)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }))
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "unique-test-password" } })
    fireEvent.click(screen.getByRole("button", { name: "Turn off two-step sign-in" }))
    await waitFor(() => expect(service.disable).toHaveBeenCalledWith("unique-test-password"))
    expect(await screen.findByRole("button", { name: "Turn on" })).toBeTruthy()
  })

  test("stays hidden when the server does not offer it", async () => {
    const service = { status: vi.fn(async () => null) } as unknown as TwoFactorService
    const { container } = render(<TwoFactorCard service={service} />)
    await waitFor(() => expect(container.textContent).toBe(""))
  })
})
