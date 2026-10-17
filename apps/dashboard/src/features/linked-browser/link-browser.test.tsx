import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { LinkBrowserBanner, LinkBrowserSection } from "@/features/linked-browser/link-browser-card"
import { LINK_STEPS, LINK_TITLE } from "@/features/linked-browser/link-text"
import { BrowserLink, linkCode } from "@/lib/e2ee/browser-link"
import { memoryStore } from "@/lib/e2ee/keys"

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

async function startedLink(server: { linked: boolean }) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === "/api/dashboard/browser" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { browserId: string }
      return jsonResponse(200, { browserId: body.browserId, linked: server.linked })
    }
    if (url.endsWith("/link-request") && init?.method === "POST") return jsonResponse(200, { requested: true, phones: 1 })
    if (url.startsWith("/api/dashboard/browser/")) return jsonResponse(200, server.linked ? { linked: true, linkedBy: "Owner iPhone" } : { linked: false })
    return jsonResponse(404, {})
  })
  const link = new BrowserLink({ accountId: "acct_1", store: memoryStore(), fetcher: fetcher as typeof fetch, name: "Chrome on macOS" })
  await link.start()
  return { link, fetcher }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("linking this browser", () => {
  it("says so when the browser cannot hold keys, and shows no banner", () => {
    render(
      <>
        <LinkBrowserBanner accountId="acct_1" link={null} />
        <LinkBrowserSection accountId="acct_1" link={null} />
      </>
    )
    expect(screen.queryByRole("button", { name: /QR code/i })).toBeNull()
    expect(screen.getByText(/cannot keep encryption keys/i)).toBeInTheDocument()
  })

  it("shows the QR code on request, polls while it is shown and links in place, without a reload", async () => {
    const server = { linked: false }
    const { link, fetcher } = await startedLink(server)
    const onLinked = vi.fn()
    vi.useFakeTimers()
    render(<LinkBrowserBanner accountId="acct_1" link={link} onLinked={onLinked} />)
    expect(screen.getByText(LINK_TITLE)).toBeInTheDocument()
    expect(screen.queryByRole("img", { name: /QR code/i })).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    const statusCalls = () => fetcher.mock.calls.filter(([url]) => String(url).startsWith("/api/dashboard/browser/")).length
    expect(statusCalls()).toBe(0)

    fireEvent.click(screen.getByRole("button", { name: /Scan a QR code/i }))
    const qr = screen.getByRole("img", { name: /QR code/i })
    const state = link.getState()
    if (state.status !== "unlinked") throw new Error("expected unlinked")
    expect(qr.getAttribute("data-qr-value")).toBe(`relo-link:1:${state.browserId}:${state.identityKey}`)
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d/)
    expect(qr.outerHTML).not.toContain("style=")
    expect(screen.getByText(LINK_STEPS)).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(statusCalls()).toBe(1)
    expect(onLinked).not.toHaveBeenCalled()

    server.linked = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(onLinked).toHaveBeenCalledTimes(1)
    // Linked: the check holds over the code, then the banner goes away on its own (no reload).
    expect(screen.getByRole("status")).toHaveTextContent(/Linked/)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(screen.queryByText(LINK_TITLE)).toBeNull()
  })

  it("sends the request to the iPhone, shows the link code to compare, and links in place", async () => {
    const server = { linked: false }
    const { link, fetcher } = await startedLink(server)
    const state = link.getState()
    if (state.status !== "unlinked") throw new Error("expected unlinked")
    const onLinked = vi.fn()
    render(<LinkBrowserBanner accountId="acct_1" link={link} onLinked={onLinked} />)
    fireEvent.click(screen.getByRole("button", { name: /Send to my iPhone/i }))
    const code = await linkCode(state.identityKey)
    expect(await screen.findByLabelText(`Link code ${code}`)).toBeInTheDocument()
    expect(screen.getByText(/only if it shows this code/i)).toHaveTextContent("Chrome on macOS")
    expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/link-request") && init?.method === "POST")).toBe(true)
    expect(screen.getByRole("button", { name: /Send again in \d+s/i })).toBeDisabled()

    server.linked = true
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    expect(screen.getAllByRole("status").some((node) => /Linked/.test(node.textContent ?? ""))).toBe(true)
  })

  it("falls back to the QR code when no iPhone can get the request", async () => {
    const server = { linked: false }
    const { link } = await startedLink(server)
    vi.spyOn(link, "requestLink").mockResolvedValue({ ok: false, error: "no_phone" })
    render(<LinkBrowserBanner accountId="acct_1" link={link} />)
    fireEvent.click(screen.getByRole("button", { name: /Send to my iPhone/i }))
    expect(await screen.findByRole("img", { name: /QR code/i })).toBeInTheDocument()
    expect(screen.getByText(/No iPhone can get this yet/i)).toBeInTheDocument()
  })

  it("offers both ways on the Account page, and says who linked it afterwards", async () => {
    const server = { linked: false }
    const { link } = await startedLink(server)
    const { unmount } = render(<LinkBrowserSection accountId="acct_1" link={link} onLinked={() => undefined} />)
    expect(screen.getByRole("button", { name: /Send to my iPhone/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Scan a QR code/i }))
    expect(screen.getByRole("img", { name: /QR code/i })).toBeInTheDocument()
    unmount()

    server.linked = true
    await act(async () => {
      await link.checkLinked()
    })
    render(<LinkBrowserSection accountId="acct_1" link={link} onLinked={() => undefined} />)
    expect(screen.queryByRole("img", { name: /QR code/i })).toBeNull()
    expect(screen.getByText(/reads end-to-end encrypted items, linked by Owner iPhone/i)).toBeInTheDocument()
  })
})
