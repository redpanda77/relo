import type { ComputerInviteStatus } from "@relo/notification-contracts"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { b64u } from "@/lib/e2ee/bytes"
import type { BrowserLink } from "@/lib/e2ee/browser-link"
import { AddComputerControl, ConnectComputerDialog } from "@/features/onboarding/connect-computer"
import { ConnectEntry } from "@/features/onboarding/connect-entry"
import { lastInvite, rememberInvite, type ComputerInvite, type ConnectService } from "@/features/onboarding/connect-service"

const ID = "cin_00000000-0000-0000-0000-000000000001"

function made(code = "rci_abc"): ComputerInvite {
  return {
    inviteId: ID, code, command: `curl -fsSL https://relo.example/install.sh | sh -s -- ${code}`,
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(), level: "track", approvals: false, agents: null,
  }
}

function status(state: ComputerInviteStatus["state"], computer: ComputerInviteStatus["computer"] = null): ComputerInviteStatus {
  return { inviteId: ID, state, expiresAt: new Date(Date.now() + 1_800_000).toISOString(), computer }
}

const buildBox = (check: NonNullable<ComputerInviteStatus["computer"]>["check"] = null): NonNullable<ComputerInviteStatus["computer"]> => ({
  clientId: "key_1", name: "buildBox", cliVersion: "0.17.40", identityKey: null, binding: null, approval: "not_needed", check,
  harnesses: [
    { id: "claude-code", detected: true, level: "guide" },
    { id: "codex", detected: true, level: "none" },
    { id: "gemini", detected: false, level: "none" },
  ],
})

function fake(initial: ComputerInviteStatus | null = status("waiting"), phone: boolean | null = true) {
  let current = initial
  const service = {
    invite: vi.fn<ConnectService["invite"]>(async () => made()),
    status: vi.fn<ConnectService["status"]>(async () => current),
    hasPhone: vi.fn<ConnectService["hasPhone"]>(async () => phone),
    hasComputer: vi.fn<ConnectService["hasComputer"]>(async () => false),
  }
  return { service, set: (next: ComputerInviteStatus | null) => { current = next } }
}

const POLL = 30

async function open(service: ConnectService, props: { fallbackMs?: number; resumeId?: string } = {}) {
  render(<ConnectComputerDialog open onOpenChange={() => undefined} service={service} pollMs={POLL} {...props} />)
}

async function tick(ms: number) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
}

afterEach(() => { cleanup(); rememberInvite(null); localStorage.clear() })

describe("Connect a computer wizard", () => {
  it("asks how first, then shows one line to copy and starts waiting at once", async () => {
    const { service } = fake()
    await open(service)
    expect(screen.getByRole("radio", { name: /I'll run a command/ })).toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: "Make the command" }))
    expect(await screen.findByText(/install\.sh \| sh -s -- rci_abc/)).toBeInTheDocument()
    expect(service.invite).toHaveBeenCalledWith({ level: "track", approvals: false })
    expect(screen.getByRole("button", { name: /Copy command/ })).toBeInTheDocument()
    expect(screen.getByText("Waiting for your computer…")).toBeInTheDocument()
    expect(lastInvite()).toBe(ID)
  })

  it("moves through connected, agents and test as the status changes", async () => {
    const { service, set } = fake()
    await open(service)
    fireEvent.change(screen.getByLabelText("How much Relo does there"), { target: { value: "guide" } })
    fireEvent.click(screen.getByRole("button", { name: "Make the command" }))
    await screen.findByText("Waiting for your computer…")
    expect(service.invite).toHaveBeenCalledWith({ level: "guide", approvals: false })

    set(status("key_published", buildBox()))
    expect(await screen.findByText(/connected · CLI 0\.17\.40/)).toBeInTheDocument()
    expect(screen.getByText("buildBox")).toBeInTheDocument()

    set(status("reported", buildBox({ ok: true, failing: [] })))
    expect(await screen.findByRole("heading", { name: "Your agents" })).toBeInTheDocument()
    expect(screen.getByText("Claude Code connected (guide)")).toBeInTheDocument()
    expect(screen.getByText("Codex found, not connected")).toBeInTheDocument()
    expect(screen.getByText("relo setup --agent codex")).toBeInTheDocument()
    expect(screen.queryByText(/Gemini/)).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(screen.getByRole("heading", { name: "Send a test" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Continue without a test" })).toBeInTheDocument()

    set(status("tested", buildBox({ ok: true, failing: [] })))
    expect(await screen.findByText(/First notification sent/)).toBeInTheDocument()
    expect(lastInvite()).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(screen.getByText(/Relo for iPhone/)).toBeInTheDocument()
    expect(screen.getByText(/Relo for Mac/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument()
  })

  it("says so when no agent was found, and Skip continues", async () => {
    const none = { ...buildBox({ ok: true, failing: [] }), harnesses: [{ id: "codex", detected: false, level: "none" as const }] }
    const { service } = fake(status("reported", none))
    await open(service, { resumeId: ID })
    expect(await screen.findByText(/No agents found here/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Skip" }))
    expect(screen.getByRole("heading", { name: "Send a test" })).toBeInTheDocument()
  })

  it("an expired code offers a new command, which replaces the code", async () => {
    const { service, set } = fake()
    await open(service)
    fireEvent.click(screen.getByRole("button", { name: "Make the command" }))
    await screen.findByText("Waiting for your computer…")
    set(status("expired"))
    expect(await screen.findByText("Code expired")).toBeInTheDocument()
    expect(screen.queryByText(/install\.sh/)).toBeNull()
    service.invite.mockResolvedValueOnce(made("rci_new"))
    set(status("waiting"))
    fireEvent.click(screen.getByRole("button", { name: "New command" }))
    expect(await screen.findByText(/sh -s -- rci_new/)).toBeInTheDocument()
    expect(service.invite).toHaveBeenCalledTimes(2)
  })

  it("on the agent path shows the prompt, and offers the command after the fallback delay", async () => {
    const { service } = fake()
    await open(service, { fallbackMs: 300 })
    fireEvent.click(screen.getByRole("radio", { name: /Let my agent do it/ }))
    fireEvent.click(screen.getByRole("button", { name: "Make the prompt" }))
    const promptText = (await screen.findByText(/install\.md\?code=rci_abc\./)).textContent ?? ""
    const bind = /code=rci_abc\.([A-Za-z0-9_-]{22}) and/.exec(promptText)?.[1]
    expect(bind).toBeTruthy()
    const prompt = `Read ${window.location.origin}/install.md?code=rci_abc.${bind} and set up Relo on this computer at the track level. It sends me a first notification when it is done.`
    expect(promptText).toBe(prompt)
    expect(screen.getByText(/may ask your permission/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Run it yourself instead" })).toBeNull()

    fireEvent.click(await screen.findByRole("button", { name: "Run it yourself instead" }))
    expect(screen.getByText(new RegExp(`install\\.sh \\| sh -s -- rci_abc\\.${bind}`))).toBeInTheDocument()
    expect(screen.queryByText(prompt)).toBeNull()
  })

  it("does not offer the command while the agent has already connected the computer", async () => {
    const { service, set } = fake()
    await open(service, { fallbackMs: 150 })
    fireEvent.click(screen.getByRole("radio", { name: /Let my agent do it/ }))
    fireEvent.click(screen.getByRole("button", { name: "Make the prompt" }))
    await screen.findByText("Waiting for your computer…")
    set(status("redeemed", buildBox()))
    expect(await screen.findByText(/connected · CLI/)).toBeInTheDocument()
    await tick(400)
    expect(screen.queryByRole("button", { name: "Run it yourself instead" })).toBeNull()
  })

  it("names the failing checks when the computer's self-check fails", async () => {
    const { service } = fake(status("reported", buildBox({ ok: false, failing: ["server_reachable", "key_published"] })))
    await open(service, { resumeId: ID })
    await screen.findByRole("heading", { name: "Your agents" })
    expect(screen.getByText(/server_reachable, key_published/)).toBeInTheDocument()
  })

  it("without an iPhone paired, the test step says to install the app and still lets the owner continue", async () => {
    const { service } = fake(status("reported", buildBox({ ok: true, failing: [] })), false)
    await open(service, { resumeId: ID })
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }))
    expect(await screen.findByText("Install the iPhone app to see it")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Continue without a test" }))
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument()
  })

  it("an unknown invite counts as expired", async () => {
    const { service } = fake(null)
    await open(service, { resumeId: ID })
    expect(await screen.findByText("Code expired")).toBeInTheDocument()
  })

  it("Done closes the wizard as finished", async () => {
    const { service } = fake(status("tested", buildBox({ ok: true, failing: [] })))
    const onFinished = vi.fn()
    const onOpenChange = vi.fn()
    render(<ConnectComputerDialog open onOpenChange={onOpenChange} service={service} resumeId={ID} onFinished={onFinished} />)
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }))
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onFinished).toHaveBeenCalled()
  })
})

describe("AddComputerControl", () => {
  it("offers Resume for a computer whose setup did not reach the test", async () => {
    rememberInvite(ID)
    const { service } = fake(status("key_published", buildBox()))
    render(<AddComputerControl service={service} />)
    expect(await screen.findByText("buildBox: setup not finished")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(await within(screen.getByRole("dialog")).findByText(/connected · CLI/)).toBeInTheDocument()
  })

  it("shows no Resume for a finished or expired code, and forgets it", async () => {
    rememberInvite(ID)
    const { service } = fake(status("tested", buildBox()))
    render(<AddComputerControl service={service} />)
    await waitFor(() => expect(service.status).toHaveBeenCalled())
    await tick(0)
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull()
    expect(lastInvite()).toBeNull()
    expect(screen.getByRole("button", { name: "Add a computer" })).toBeInTheDocument()
  })
})

describe("Key binding", () => {
  const IDENTITY = "BAAA-identity-key"
  async function bindingFor(bind: string, clientId = "key_1", identityKey = IDENTITY) {
    const raw = Uint8Array.from(atob(bind.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
    const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`relo.e2e.v1 computer-binding\n${clientId}\n${identityKey}`))
    return b64u(new Uint8Array(mac))
  }
  const linkOf = (result: "approved" | "not_linked" | "failed" = "approved") =>
    ({ approveBoundComputer: vi.fn(async () => result) }) as unknown as BrowserLink & { approveBoundComputer: ReturnType<typeof vi.fn> }

  async function start(link: BrowserLink | null, binding: (bind: string) => Promise<string>) {
    const { service, set } = fake()
    render(<ConnectComputerDialog open onOpenChange={() => undefined} service={service} pollMs={POLL} link={link} />)
    fireEvent.click(screen.getByRole("button", { name: "Make the command" }))
    const text = (await screen.findByText(/sh -s -- rci_abc\./)).textContent ?? ""
    const bind = /rci_abc\.([A-Za-z0-9_-]{22})/.exec(text)?.[1] ?? ""
    expect(bind).toHaveLength(22)
    set(status("key_published", { ...buildBox(), identityKey: IDENTITY, binding: await binding(bind) }))
    return bind
  }

  it("approves once when the binding matches and this browser is linked", async () => {
    const link = linkOf()
    await start(link, (bind) => bindingFor(bind))
    expect(await screen.findByText(/Approved on this browser/)).toBeInTheDocument()
    await tick(POLL * 4)
    expect(link.approveBoundComputer).toHaveBeenCalledTimes(1)
    expect(link.approveBoundComputer).toHaveBeenCalledWith("key_1", IDENTITY)
  })

  it("warns and does not approve when the binding does not match", async () => {
    const link = linkOf()
    await start(link, (bind) => bindingFor(bind, "key_1", "BAAA-swapped-key"))
    expect(await screen.findByText("This computer's key doesn't match the code. It was not approved.")).toBeInTheDocument()
    expect(link.approveBoundComputer).not.toHaveBeenCalled()
  })

  it("notes that the iPhone will ask when this browser is not linked", async () => {
    await start(null, (bind) => bindingFor(bind))
    expect(await screen.findByText("Your iPhone will ask to approve this computer")).toBeInTheDocument()
  })
})

describe("Approval, restart hint, options, resume and typed code", () => {
  const waitingBox = () => ({ ...buildBox({ ok: true, failing: [] }), approval: "waiting" as const })

  it("says to approve on the iPhone while approval is waiting, in the computer and test steps", async () => {
    const { service, set } = fake()
    await open(service)
    fireEvent.click(screen.getByRole("button", { name: "Make the command" }))
    await screen.findByText("Waiting for your computer…")
    set(status("redeemed", waitingBox()))
    expect(await screen.findByText("Approve buildBox on your iPhone. Until then its notifications stay locked there.")).toBeInTheDocument()
    set(status("reported", waitingBox()))
    await screen.findByRole("heading", { name: "Your agents" })
    expect(screen.getByText(/Until then its notifications stay locked/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(screen.getByText(/Until then its notifications stay locked/)).toBeInTheDocument()
    set(status("tested", waitingBox()))
    expect(await screen.findByText("First notification sent. It opens on your iPhone once you approve buildBox.")).toBeInTheDocument()
  })

  it("keeps the plain wording when approval is approved or not needed", async () => {
    const { service } = fake(status("tested", { ...buildBox(), approval: "approved" }))
    await open(service, { resumeId: ID })
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }))
    expect(screen.queryByText(/stay locked/)).toBeNull()
    expect(await screen.findByText("First notification sent. Look at your iPhone.")).toBeInTheDocument()
  })

  it("an approval signed here drops the waiting line once the status says approved", async () => {
    const IDENTITY = "BAAA-identity-key"
    const link = { approveBoundComputer: vi.fn(async () => "approved") } as unknown as BrowserLink
    const { service, set } = fake()
    render(<ConnectComputerDialog open onOpenChange={() => undefined} service={service} pollMs={POLL} link={link} />)
    fireEvent.click(screen.getByRole("button", { name: "Make the command" }))
    const text = (await screen.findByText(/sh -s -- rci_abc\./)).textContent ?? ""
    const bind = /rci_abc\.([A-Za-z0-9_-]{22})/.exec(text)?.[1] ?? ""
    const raw = Uint8Array.from(atob(bind.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
    const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`relo.e2e.v1 computer-binding\nkey_1\n${IDENTITY}`))
    set(status("key_published", { ...waitingBox(), identityKey: IDENTITY, binding: b64u(new Uint8Array(mac)) }))
    expect(await screen.findByText(/Approved on this browser/)).toBeInTheDocument()
    expect(screen.queryByText(/stay locked/)).toBeNull()
  })

  it("tells the owner to restart the connected agents", async () => {
    const { service } = fake(status("reported", buildBox({ ok: true, failing: [] })))
    await open(service, { resumeId: ID })
    expect(await screen.findByText("Restart Claude Code on buildBox so they load Relo. Sessions already open don't see it until then.")).toBeInTheDocument()
  })

  it("sends approvals and the picked agents from Options", async () => {
    const { service } = fake()
    await open(service)
    fireEvent.click(screen.getByText("Options"))
    fireEvent.click(screen.getByRole("checkbox", { name: "Ask permission on my iPhone too" }))
    fireEvent.click(screen.getByRole("radio", { name: "Only the ones I pick" }))
    expect(screen.getByRole("button", { name: "Make the command" })).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox", { name: "Codex" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Amp" }))
    fireEvent.click(screen.getByRole("button", { name: "Make the command" }))
    await screen.findByText("Waiting for your computer…")
    expect(service.invite).toHaveBeenCalledWith({ level: "track", approvals: true, agents: ["claude-code", "codex", "amp"] })
  })

  it("Resume reopens on the same command, still waiting", async () => {
    const { service } = fake()
    const first = render(<ConnectComputerDialog open onOpenChange={() => undefined} service={service} pollMs={POLL} />)
    fireEvent.click(screen.getByRole("radio", { name: /Let my agent do it/ }))
    fireEvent.click(screen.getByRole("button", { name: "Make the prompt" }))
    const promptText = (await screen.findByText(/install\.md\?code=rci_abc\./)).textContent ?? ""
    first.unmount()
    await open(service, { resumeId: ID })
    expect(await screen.findByText(promptText)).toBeInTheDocument()
    expect(screen.getByText("Waiting for your computer…")).toBeInTheDocument()
    expect(service.invite).toHaveBeenCalledTimes(1)
  })

  it("after a reload (no memory) a waiting code needs a new command", async () => {
    rememberInvite(ID)
    const { service } = fake(status("waiting"))
    render(<AddComputerControl service={service} />)
    await waitFor(() => expect(service.status).toHaveBeenCalled())
    await tick(0)
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull()
  })

  it("Settings offers Resume while the code is still waiting", async () => {
    const { service } = fake()
    const first = render(<ConnectComputerDialog open onOpenChange={() => undefined} service={service} pollMs={POLL} />)
    fireEvent.click(screen.getByRole("button", { name: "Make the command" }))
    await screen.findByText(/sh -s -- rci_abc\./)
    first.unmount()
    render(<AddComputerControl service={service} />)
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }))
    expect(await within(await screen.findByRole("dialog")).findByText(/sh -s -- rci_abc\./)).toBeInTheDocument()
  })

  it("Now offers Resume for a waiting command", async () => {
    const { service } = fake()
    const first = render(<ConnectComputerDialog open onOpenChange={() => undefined} service={service} pollMs={POLL} />)
    fireEvent.click(screen.getByRole("button", { name: "Make the command" }))
    await screen.findByText(/sh -s -- rci_abc\./)
    first.unmount()
    render(<ConnectEntry service={service} />)
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }))
    expect(await within(await screen.findByRole("dialog")).findByText(/sh -s -- rci_abc\./)).toBeInTheDocument()
  })

  it("My computer shows a code opens the approval page with a normalized code", async () => {
    const { service } = fake()
    const navigate = vi.fn()
    render(<ConnectComputerDialog open onOpenChange={() => undefined} service={service} navigate={navigate} />)
    fireEvent.click(screen.getByRole("radio", { name: /My computer shows a code/ }))
    expect(screen.getByText(/ran relo auth login and shows a code/)).toBeInTheDocument()
    const button = screen.getByRole("button", { name: "Open the approval page" })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Code on the computer"), { target: { value: "abcd efgh" } })
    fireEvent.click(button)
    expect(navigate).toHaveBeenCalledWith("/cli/authorize?code=ABCD-EFGH")
    expect(service.invite).not.toHaveBeenCalled()
  })
})
