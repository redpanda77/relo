import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PendingDevicesNotice } from "@/features/pending-devices/pending-devices"
import { PENDING_DEVICES_PATH, PENDING_DEVICES_POLL_MS } from "@/features/pending-devices/pending-devices-data"

const device = {
  deviceId: "dev_new",
  name: "Test iPad",
  model: "iPad16,3",
  modelName: "iPad Pro 11-inch (M4)",
  registeredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  keyId: "k_new",
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

let visibility: DocumentVisibilityState = "visible"

beforeEach(() => {
  visibility = "visible"
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("PendingDevicesNotice", () => {
  it("shows each pending device with where to approve it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ devices: [device] }))
    render(<PendingDevicesNotice />)

    const notice = await screen.findByRole("status", { name: "New devices waiting for approval" })
    expect(notice).toHaveTextContent("Test iPad (iPad Pro 11-inch (M4)) wants to read your Relo cards, signed in 5 minutes ago.")
    expect(notice).toHaveTextContent("Approve or decline it in Devices or in Relo on your iPhone → Settings → Devices.")
    expect(screen.getByRole("link", { name: "Approve or decline it in Devices" })).toHaveAttribute("href", "/dashboard/account#devices")
    expect(fetchMock).toHaveBeenCalledWith(PENDING_DEVICES_PATH, expect.objectContaining({ credentials: "same-origin" }))
  })

  it("renders nothing when the list is empty", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ devices: [] }))
    const { container } = render(<PendingDevicesNotice variant="card" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(container).toBeEmptyDOMElement()
  })

  it.each([401, 404])("hides silently and stops polling on %i", async (status) => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "nope" }, status))
    const { container } = render(<PendingDevicesNotice />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_DEVICES_POLL_MS * 2)
    })
    expect(container).toBeEmptyDOMElement()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("polls every minute while visible, skips while hidden, and clears once approved", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ devices: [device] }))
      .mockResolvedValueOnce(json({ devices: [] }))
    render(<PendingDevicesNotice />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText(/Test iPad/)).toBeInTheDocument()

    visibility = "hidden"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_DEVICES_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    visibility = "visible"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_DEVICES_POLL_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Test iPad/)).toBeNull()
  })

  it("keeps the last list through a transient server error", async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ devices: [device] }))
      .mockResolvedValueOnce(json({ error: "busy" }, 503))
    render(<PendingDevicesNotice />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_DEVICES_POLL_MS)
    })
    expect(screen.getByText(/Test iPad/)).toBeInTheDocument()
  })
})
