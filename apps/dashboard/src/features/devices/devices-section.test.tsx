import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DevicesSection } from "@/features/devices/devices-section"
import type { DeviceRow, DevicesService, DevicesView } from "@/features/devices/devices-service"
import type { BrowserLink, BrowserLinkState } from "@/lib/e2ee/browser-link"
import { approveDeviceSigningInput, verifyBytes } from "@/lib/e2ee/envelope"
import { fromB64u } from "@/lib/e2ee/bytes"

const seen = new Date(Date.now() - 5 * 60_000).toISOString()
const pendingKey = "B".repeat(87)

function devices(): DeviceRow[] {
  return [
    { id: "dev_main", kind: "phone", name: "Owner iPhone", model: "iPhone 18 Pro Max", status: "can_read", addedAt: seen, lastSeenAt: seen },
    { id: "dev_sim", kind: "phone", name: "iPhone Air", model: "Simulator", status: "simulator", addedAt: seen, lastSeenAt: seen },
    { id: "dev_new", kind: "phone", name: "Test iPad", model: "iPad Pro 11-inch (M4)", status: "pending", addedAt: seen, lastSeenAt: seen, identityKey: pendingKey, keyId: "k_new" },
    { id: "key_mac", kind: "computer", name: "Studio Mac", model: null, status: "encrypts", addedAt: seen, lastSeenAt: seen },
    { id: "brw_this", kind: "browser", name: "Chrome on macOS", model: null, status: "can_read", addedAt: seen, lastSeenAt: seen, linkedBy: "Owner iPhone" },
    { id: "brw_old", kind: "browser", name: "Safari on macOS", model: null, status: "unlinked", addedAt: seen, lastSeenAt: null },
  ]
}

function fakeService(view: DevicesView) {
  return {
    list: vi.fn<DevicesService["list"]>(async () => view),
    approve: vi.fn<DevicesService["approve"]>(async () => undefined),
    remove: vi.fn<DevicesService["remove"]>(async () => undefined),
  }
}

/** A BrowserLink stand-in in a fixed state, signing with a real WebCrypto key. */
async function fakeLink(state: BrowserLinkState) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const link = {
    getState: () => state,
    subscribe: () => () => undefined,
    start: async () => undefined,
    checkLinked: vi.fn(async () => state.status === "linked"),
    async signApproval(target: { deviceId: string; identityKey: string }) {
      const signedAt = new Date().toISOString()
      const message = approveDeviceSigningInput({ ...target, approverDeviceId: "brw_this", signedAt })
      const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, message))
      return { browserId: "brw_this", identityKey: target.identityKey, signedAt, signature: btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "") }
    },
  }
  return { link: link as unknown as BrowserLink, publicKey }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("DevicesSection", () => {
  it("lists phones, computers and browsers with a plain encryption status", async () => {
    const service = fakeService({ devices: devices(), twoFactorEnabled: false })
    const { link } = await fakeLink({ status: "linked", browserId: "brw_this", identityKey: "A".repeat(87), linkedBy: "Owner iPhone" })
    render(<DevicesSection accountId="acct_1" service={service} link={link} />)

    const phones = await screen.findByRole("list", { name: "Phones" })
    expect(within(phones).getByText("Owner iPhone").closest("li")).toHaveTextContent("iPhone 18 Pro Max · seen 5 minutes ago")
    expect(within(phones).getByText("Owner iPhone").closest("li")).toHaveTextContent("Can read your encrypted cards")
    expect(within(phones).getByText("iPhone Air").closest("li")).toHaveTextContent("Simulator")
    expect(within(phones).getByText("Test iPad").closest("li")).toHaveTextContent("Waiting for approval")
    expect(within(screen.getByRole("list", { name: "Computers" })).getByText("Sends encrypted cards")).toBeInTheDocument()
    const browsers = screen.getByRole("list", { name: "Browsers" })
    expect(within(browsers).getByText("Chrome on macOS").closest("li")).toHaveTextContent("This browser")
    expect(within(browsers).getByText("Safari on macOS").closest("li")).toHaveTextContent("Not linked — can't read encrypted content")
    expect(within(browsers).getByText("Safari on macOS").closest("li")).not.toHaveTextContent("This browser")
    // Linked: no QR prompt.
    expect(screen.queryByRole("img", { name: /QR code/i })).toBeNull()
  })

  it("approves a pending phone from a linked browser, with the same signature a phone makes", async () => {
    const service = fakeService({ devices: devices(), twoFactorEnabled: true })
    const { link, publicKey } = await fakeLink({ status: "linked", browserId: "brw_this", identityKey: "A".repeat(87), linkedBy: "Owner iPhone" })
    render(<DevicesSection accountId="acct_1" service={service} link={link} />)
    const row = (await screen.findByText("Test iPad")).closest("li")!
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }))
    expect(await screen.findByText("Approve Test iPad?")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Code from your authenticator app"), { target: { value: "123456" } })
    fireEvent.submit(screen.getByLabelText("Code from your authenticator app").closest("form")!)
    await waitFor(() => expect(service.approve).toHaveBeenCalledOnce())
    const [deviceId, approval, code] = service.approve.mock.calls[0]!
    expect(deviceId).toBe("dev_new")
    expect(code).toBe("123456")
    expect(approval).toMatchObject({ browserId: "brw_this", identityKey: pendingKey })
    const message = approveDeviceSigningInput({ deviceId: "dev_new", identityKey: pendingKey, approverDeviceId: "brw_this", signedAt: approval.signedAt })
    expect(await verifyBytes(publicKey, message, fromB64u(approval.signature, { length: 64 }))).toBe(true)
  })

  it("explains that an unlinked browser must be linked first, and shows the link flow", async () => {
    const service = fakeService({ devices: devices(), twoFactorEnabled: false })
    const { link } = await fakeLink({ status: "unlinked", browserId: "brw_old", identityKey: "A".repeat(87) })
    render(<DevicesSection accountId="acct_1" service={service} link={link} onLinked={() => undefined} />)
    const row = (await screen.findByText("Test iPad")).closest("li")!
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull()
    expect(within(row).getByRole("link", { name: "Link this browser from your iPhone first" })).toHaveAttribute("href", "#linked-browser")
    expect(screen.getByRole("img", { name: "QR code to link this browser" })).toBeInTheDocument()
  })

  it("removes after a clear confirmation, and Decline removes a pending phone", async () => {
    const service = fakeService({ devices: devices(), twoFactorEnabled: false })
    const { link } = await fakeLink({ status: "linked", browserId: "brw_this", identityKey: "A".repeat(87), linkedBy: "Owner iPhone" })
    render(<DevicesSection accountId="acct_1" service={service} link={link} />)
    const main = (await screen.findByText("Owner iPhone")).closest("li")!
    fireEvent.click(within(main).getByRole("button", { name: "Remove" }))
    expect(await screen.findByText("It is signed out and can no longer read anything. Cards only it could open are deleted.")).toBeInTheDocument()
    expect(service.remove).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(service.remove).toHaveBeenCalledWith(expect.objectContaining({ id: "dev_main", kind: "phone" })))

    const pending = screen.getByText("Test iPad").closest("li")!
    fireEvent.click(within(pending).getByRole("button", { name: "Decline" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Decline" }))
    await waitFor(() => expect(service.remove).toHaveBeenCalledWith(expect.objectContaining({ id: "dev_new" })))
  })

  it("stays hidden on a server without the Devices route", async () => {
    const service = { ...fakeService({ devices: [], twoFactorEnabled: false }), list: vi.fn(async () => null) }
    const { container } = render(<DevicesSection accountId="acct_1" service={service} link={null} />)
    await waitFor(() => expect(service.list).toHaveBeenCalled())
    await waitFor(() => expect(container.textContent).toBe(""))
  })
})
