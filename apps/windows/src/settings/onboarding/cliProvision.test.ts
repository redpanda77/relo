import { afterEach, describe, expect, it, vi } from "vitest"
import { INVITE_REQUEST_EVENT, INVITE_RESULT_EVENT, inviteProblem, parseInviteRequest } from "../../client/cliInvite"
import { INVITE_UNANSWERED, PROVISION_FAILED, provisionCli, requestInvite, wordsOf, type InviteIo, type Prepared, type ProvisionDeps } from "./cliProvision"
import { OwnerClientError } from "@relo/owner-client"

const ORIGIN = "https://relo.example.com"
const CODE = `rci_${"A".repeat(32)}`
const prepared = (over: Partial<Prepared> = {}): Prepared => ({ launcher: "written", note: null, pathReady: true, signedIn: false, ...over })

function deps(over: Partial<ProvisionDeps> = {}) {
  const calls: string[] = []
  const d: ProvisionDeps = {
    prepare: async (o) => (calls.push(`prepare ${o}`), prepared()),
    invite: async (o) => (calls.push(`invite ${o}`), CODE),
    join: async (o, code) => void calls.push(`join ${o} ${code}`),
    ...over,
  }
  return { d, calls }
}

describe("the relo command after a server sign-in", () => {
  it("writes the command and path first, then asks for a code, then signs the CLI in", async () => {
    const { d, calls } = deps()
    expect(await provisionCli(ORIGIN, d)).toEqual({ ok: true, note: null })
    expect(calls).toEqual([`prepare ${ORIGIN}`, `invite ${ORIGIN}`, `join ${ORIGIN} ${CODE}`])
  })

  it("asks for no code when the CLI is already signed in to this server", async () => {
    const { d, calls } = deps({ prepare: async () => prepared({ signedIn: true, note: "Another relo command is installed; Relo for Windows' agents use it." }) })
    expect(await provisionCli(ORIGIN, d)).toEqual({ ok: true, note: "Another relo command is installed; Relo for Windows' agents use it." })
    expect(calls).toEqual([])
  })

  it("stops at the first problem and says it in the words it was given", async () => {
    const noCommand = deps({ prepare: async () => Promise.reject("This copy of Relo does not include the relo command. Install Relo again from your server's download page.") })
    expect(await provisionCli(ORIGIN, noCommand.d)).toEqual({ ok: false, message: "This copy of Relo does not include the relo command. Install Relo again from your server's download page." })
    expect(noCommand.calls).toEqual([])

    const noCode = deps({ invite: async () => Promise.reject("Your server did not give Relo a one-time code. Try again.") })
    expect(await provisionCli(ORIGIN, noCode.d)).toEqual({ ok: false, message: "Your server did not give Relo a one-time code. Try again." })

    const noJoin = deps({ join: async () => Promise.reject("Relo could not sign the relo command in to your server. Try again.") })
    expect(await provisionCli(ORIGIN, noJoin.d)).toMatchObject({ ok: false, message: "Relo could not sign the relo command in to your server. Try again." })
  })

  it("never shows a bridge error or a stack trace", async () => {
    const { d } = deps({ join: async () => Promise.reject(new Error("invoke failed\n  at foo (bar.js:1:1)")) })
    expect(await provisionCli(ORIGIN, d)).toEqual({ ok: false, message: PROVISION_FAILED })
    expect(wordsOf("")).toBe(PROVISION_FAILED)
    expect(wordsOf(undefined)).toBe(PROVISION_FAILED)
  })
})

describe("asking the signed-in app for the one-time code", () => {
  afterEach(() => vi.useRealTimers())

  function io() {
    const listeners = new Map<string, (p: unknown) => void>()
    const emitted: Array<[string, unknown]> = []
    const offs: string[] = []
    const value: InviteIo = {
      listen: (name, cb) => (listeners.set(name, cb), () => void offs.push(name)),
      emit: (name, payload) => void emitted.push([name, payload]),
      newId: () => "req-1",
    }
    return { value, listeners, emitted, offs }
  }

  it("listens before it asks and resolves with the answer for its own request", async () => {
    const t = io()
    const asked = requestInvite(ORIGIN, t.value, INVITE_REQUEST_EVENT, INVITE_RESULT_EVENT)
    expect(t.emitted).toEqual([[INVITE_REQUEST_EVENT, { id: "req-1", origin: ORIGIN }]])
    const answer = t.listeners.get(INVITE_RESULT_EVENT)!
    answer({ id: "someone-else", code: "rci_other" })
    answer({ id: "req-1", code: CODE })
    expect(await asked).toBe(CODE)
    expect(t.offs).toEqual([INVITE_RESULT_EVENT])
  })

  it("rejects with the notch's words, or its own when the answer carries none", async () => {
    const t = io()
    const asked = requestInvite(ORIGIN, t.value, INVITE_REQUEST_EVENT, INVITE_RESULT_EVENT)
    t.listeners.get(INVITE_RESULT_EVENT)!({ id: "req-1", problem: "Your server asked Relo to wait a moment. Try again in a minute." })
    await expect(asked).rejects.toBe("Your server asked Relo to wait a moment. Try again in a minute.")
    const t2 = io()
    const empty = requestInvite(ORIGIN, t2.value, INVITE_REQUEST_EVENT, INVITE_RESULT_EVENT)
    t2.listeners.get(INVITE_RESULT_EVENT)!({ id: "req-1" })
    await expect(empty).rejects.toBe(INVITE_UNANSWERED)
  })

  it("gives up when nothing answers", async () => {
    vi.useFakeTimers()
    const t = io()
    const asked = requestInvite(ORIGIN, t.value, INVITE_REQUEST_EVENT, INVITE_RESULT_EVENT, 1000)
    const settled = expect(asked).rejects.toBe(INVITE_UNANSWERED)
    await vi.advanceTimersByTimeAsync(1000)
    await settled
    expect(t.offs).toEqual([INVITE_RESULT_EVENT])
  })
})

describe("the notch's side of the request", () => {
  it("reads only an id and an origin from the event", () => {
    expect(parseInviteRequest({ id: "a", origin: ORIGIN, extra: 1 })).toEqual({ id: "a", origin: ORIGIN })
    for (const bad of [null, {}, { id: "", origin: ORIGIN }, { id: 5, origin: ORIGIN }, { id: "a" }, { id: "x".repeat(65), origin: ORIGIN }]) {
      expect(parseInviteRequest(bad)).toBeNull()
    }
  })

  it("words each failure plainly, with no status code", () => {
    for (const kind of ["unauthorized", "rate_limited", "unreachable", "unavailable", "invalid_response"] as const) {
      expect(inviteProblem(new OwnerClientError(kind, 429))).not.toMatch(/\d{3}|unauthorized|_/)
    }
    expect(inviteProblem(new Error("boom"))).toBe("Your server did not give Relo a one-time code. Try again.")
  })
})
