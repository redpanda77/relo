import { afterEach, describe, expect, it, vi } from "vitest"

import * as cli from "@relo/cli-e2ee"
import { displayName, forgetNames } from "@/lib/encrypted"

import { BrowserLink } from "./browser-link"
import { fromB64u } from "./bytes"
import { memoryStore } from "./keys"
import { openSealedTree } from "./open-sealed"

const PROJECT = "p-abcdefghijklmnop"
const COMPUTER = "c-bcdefghijklmnopq"
const SESSION_PROJECT = "p-cdefghijklmnopqr"
const UNKNOWN = "t-defghijklmnopqrs"

function page() {
  return {
    kind: "inbox-overview",
    shell: { account: { id: "acct_1" } },
    route: { path: `/dashboard/inbox?project=${PROJECT}` },
    filterOptions: { projects: [PROJECT] },
    pendingResponses: [{ notificationId: "ntf_q1", encrypted: true, title: "Encrypted question", prompt: "Encrypted question", source: COMPUTER }],
    recentNotifications: [
      {
        id: "ntf_n1",
        encrypted: true,
        title: "Encrypted notice",
        body: "Encrypted",
        context: { project: PROJECT, taskTitle: `Work on ${UNKNOWN}` },
        question: { kind: "question", encrypted: true, prompt: "Encrypted question" },
        activity: {
          id: "act_a1",
          encrypted: true,
          title: "Encrypted card",
          status: "Updating…",
          detail: null,
          steps: { done: 1, total: 3, current: "Step 2" },
          stepItems: [{ label: "Step 1", state: "done" }, { label: "Step 2", state: "active" }, { label: "Step 3", state: "pending" }],
        },
      },
      { id: "ntf_locked", encrypted: true, title: "Encrypted notice", body: "Encrypted" },
      { id: "ntf_plain", title: "Plain", body: "Readable" },
    ],
    sessions: [{ id: "ags_s1", project: SESSION_PROJECT, computer: COMPUTER }],
  }
}

const contents: Record<string, unknown> = {
  ntf_q1: { title: "Deploy?", summary: "Ship 0.15.5 to production?", body: "Ship 0.15.5 to production?" },
  ntf_n1: { title: "Tests passed", summary: "848 green", body: "## Result\nAll good", names: { [PROJECT]: "relo" } },
  act_a1: { title: "Release", status: "Building", detail: "iOS archive", steps: ["Lint", "Build", "Upload"], names: { [COMPUTER]: "Studio Mac" } },
  ags_s1: { names: { [SESSION_PROJECT]: "relo-ios" } },
}

afterEach(() => forgetNames())

describe("openSealedTree", () => {
  it("replaces placeholders, resolves handles and leaves unopenable items locked", async () => {
    const fetchEnvelopes = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.filter((id) => id in contents).map((id) => [id, { id }]))
    )
    const original = page()
    const { tree, opened } = await openSealedTree(original, {
      fetchEnvelopes,
      open: async (envelope) => contents[(envelope as { id: string }).id] ?? null,
    })
    expect(fetchEnvelopes).toHaveBeenCalledTimes(1)
    expect(fetchEnvelopes.mock.calls[0]![0].sort()).toEqual(["act_a1", "ags_s1", "ntf_locked", "ntf_n1", "ntf_q1"])
    expect(opened).toBe(4)
    expect(original.recentNotifications[0]!.title).toBe("Encrypted notice")

    expect(tree.pendingResponses[0]).toMatchObject({ encrypted: false, opened: true, title: "Deploy?", prompt: "Ship 0.15.5 to production?", source: "Studio Mac" })
    const [notice, locked, plain] = tree.recentNotifications
    expect(notice).toMatchObject({ encrypted: false, title: "Tests passed", body: "## Result\nAll good", context: { project: "relo", taskTitle: `Work on ${UNKNOWN}` } })
    expect(notice!.question).toMatchObject({ encrypted: false, prompt: "848 green" })
    expect(notice!.activity).toMatchObject({
      encrypted: false,
      title: "Release",
      status: "Building",
      detail: "iOS archive",
      steps: { current: "Build" },
      stepItems: [{ label: "Lint" }, { label: "Build" }, { label: "Upload" }],
    })
    expect(locked).toEqual({ id: "ntf_locked", encrypted: true, title: "Encrypted notice", body: "Encrypted" })
    expect(plain).toEqual({ id: "ntf_plain", title: "Plain", body: "Readable" })
    expect(tree.sessions[0]).toMatchObject({ id: "ags_s1", project: "relo-ios", computer: "Studio Mac" })
    // Links and server filter values keep the handle; displayName() names it.
    expect(tree.route.path).toContain(PROJECT)
    expect(tree.filterOptions.projects).toEqual([PROJECT])
    expect(displayName(PROJECT)).toBe("relo")
    expect(displayName(UNKNOWN)).toBe("Encrypted topic")
  })

  it("makes no request when nothing is sealed", async () => {
    const fetchEnvelopes = vi.fn(async () => ({}))
    const tree = { kind: "docs", items: [{ id: "x", title: "Plain" }] }
    expect((await openSealedTree(tree, { fetchEnvelopes, open: async () => null })).tree).toBe(tree)
    expect(fetchEnvelopes).not.toHaveBeenCalled()
  })
})

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("BrowserLink end to end with the CLI's sealing", () => {
  it("registers, reads only after linking, trusts computers on first use and opens real envelopes", async () => {
    const computer = cli.generateKeyPair()
    const computerKey = cli.b64u(computer.publicKey)
    const registrations: Array<Record<string, unknown>> = []
    let linked = false
    let envelopes: Record<string, unknown> = {}
    let clientKey = computerKey
    let taken = true
    const sealedRequests: Array<{ url: string; browser: string | null }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === "/api/dashboard/browser" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        registrations.push(body)
        if (taken) {
          taken = false
          return jsonResponse(409, { error: "browser_id_taken" })
        }
        return jsonResponse(200, { browserId: body.browserId, linked })
      }
      if (url.startsWith("/api/dashboard/browser/")) return jsonResponse(200, linked ? { linked, linkedBy: "Owner iPhone" } : { linked })
      if (url === "/api/dashboard/client-keys") {
        return jsonResponse(200, { clients: [{ clientId: "key_1", name: "Mac", keyId: cli.keyId(fromB64u(clientKey)), publicKey: clientKey }] })
      }
      if (url.startsWith("/api/dashboard/sealed?")) {
        sealedRequests.push({ url, browser: new Headers(init?.headers).get("x-relo-browser") })
        if (!linked) return jsonResponse(403, { error: "browser_not_linked" })
        return jsonResponse(200, { envelopes })
      }
      return jsonResponse(404, {})
    })
    const store = memoryStore()
    const link = new BrowserLink({ accountId: "acct_1", store, fetcher: fetcher as typeof fetch, name: "Chrome on macOS" })
    await link.start()

    // 409 picks a new id once; the prekey is signed for the id that was accepted.
    expect(registrations).toHaveLength(2)
    expect(registrations[1]!.browserId).not.toBe(registrations[0]!.browserId)
    const state = link.getState()
    expect(state.status).toBe("unlinked")
    if (state.status !== "unlinked") throw new Error("unreachable")
    expect(state.browserId).toBe(registrations[1]!.browserId)
    const prekey = registrations[1]!.prekey as { prekeyId: string; publicKey: string; createdAt: string; signature: string }
    expect(cli.verifyPrekey({ identityPublicKey: fromB64u(state.identityKey), prekey: { ...prekey, deviceId: state.browserId } })).toBe(true)
    expect(await link.opener()).toBeNull()

    linked = true
    expect(await link.checkLinked()).toBe(true)
    expect(link.getState()).toMatchObject({ status: "linked", linkedBy: "Owner iPhone" })

    envelopes = {
      ntf_n1: cli.sealEnvelope({
        kind: "notice",
        context: "ntf:1",
        sender: { privateKey: computer.privateKey },
        recipients: [{ deviceId: state.browserId, prekeyId: prekey.prekeyId, publicKey: fromB64u(prekey.publicKey) }],
        content: { title: "Opened in the browser", summary: "for real", names: { [PROJECT]: "relo" } },
      }),
    }
    const opener = (await link.opener())!
    const { tree } = await openSealedTree(page(), opener)
    expect(tree.recentNotifications[0]).toMatchObject({ title: "Opened in the browser", body: "for real", context: { project: "relo" } })
    expect(tree.pendingResponses[0]!.encrypted).toBe(true)
    expect(sealedRequests.at(-1)!.browser).toBe(state.browserId)

    // A different computer key for the same client is accepted, with a console note only.
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    clientKey = cli.b64u(cli.generateKeyPair().publicKey)
    const senders = await link.trustedSenders()
    expect(info).toHaveBeenCalledWith(expect.stringContaining("security code for Mac changed"))
    expect([...senders.keys()]).toEqual([cli.keyId(fromB64u(clientKey))])
    info.mockRestore()

    // Unlinked on the phone: the server answers 403 and the browser shows the QR code again.
    linked = false
    expect(await opener.fetchEnvelopes(["ntf_n1"])).toEqual({})
    expect(link.getState().status).toBe("unlinked")
  })
})
