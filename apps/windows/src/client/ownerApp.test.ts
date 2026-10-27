// Sign-in, failures, notices, updates and the sign-out flows of the Windows owner app, against owner-client's fake
// server and fake ports (no Tauri, no network).

import { createPkce, memoryStore, type DeviceInfo } from "@relo/owner-client"
import { memoryStore as keyStore } from "@relo/owner-crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FakeServer, INTERACTION, notice, ORIGIN } from "../../../../packages/owner-client/src/test-support/fakeServer"
import type * as bridge from "../bridge"
import { OFF, type LocalState } from "../local/api"
import type { InviteReport, InviteRequest } from "./cliInvite"
import type { EncryptionReport, EncryptionRequest, UpdateState } from "./native"
import { OwnerApp, type Ports } from "./ownerApp"

const CODE = "relo_signin_" + "A".repeat(43)
const info: DeviceInfo = { name: "PC", bundleIdentifier: "ai.relo.windows", appVersion: "0.1.0", appBuild: "1", osVersion: "Windows 11" }
const apps: OwnerApp[] = []
afterEach(() => apps.splice(0).forEach((app) => app.stop()))

interface HarnessOptions {
  server?: FakeServer
  launch?: bridge.LaunchArgs | null
  probe?: number | null
  window?: "ok" | "fails"
  autoInstall?: boolean
  fetch?: (inner: FakeServer["fetch"]) => FakeServer["fetch"]
  local?: LocalState
  voice?: { button?: boolean; speaks?: boolean }
  hidden?: boolean
  manualCheck?: UpdateState | null
  retryProblem?: string | null
  prefs?: ReturnType<typeof memoryStore>
  secrets?: ReturnType<typeof memoryStore>
  now?: () => number
}

function harness(options: HarnessOptions = {}) {
  const server = options.server ?? new FakeServer()
  const secrets = options.secrets ?? memoryStore()
  const prefs = options.prefs ?? memoryStore()
  const keys = keyStore()
  const calls = {
    windows: [] as string[], browser: [] as string[], closed: 0, logs: [] as string[], toasts: [] as Array<[string, string]>,
    trays: [] as bridge.TrayState[], configured: [] as Array<[string | null, boolean]>, installed: 0, manualChecks: 0, retries: 0,
    voiceStarts: 0, encryption: [] as EncryptionReport[], invites: [] as InviteReport[],
  }
  const on = {
    signIn: [] as Array<(origin: string | null) => void>, signOut: [] as Array<() => void>, auth: [] as Array<(url: string) => void>, closed: [] as Array<() => void>,
    tray: [] as Array<(a: bridge.TrayAction) => void>, update: [] as Array<(s: UpdateState) => void>,
    localState: [] as Array<(s: LocalState) => void>, localUpdated: [] as Array<(u: { version: string | null; agents: "refreshed" | "failed" }) => void>,
    encryption: [] as Array<(r: EncryptionRequest) => void>,
    invite: [] as Array<(r: InviteRequest) => void>,
  }
  const localState: LocalState = { ...(options.local ?? OFF) }
  const voice = { button: options.voice?.button ?? true, speaks: options.voice?.speaks ?? false }
  const sub = <T>(list: T[]) => (cb: T) => { list.push(cb); return () => {} }
  let after: { version: string; agents: "refreshed" | "failed" | "notApplicable" } | null = null
  const ports: Ports = {
    fetch: options.fetch ? options.fetch(server.fetch) : server.fetch, secrets, prefs, keys,
    device: async () => info,
    openUrl: async (url) => void calls.browser.push(url),
    setTray: async (state) => void calls.trays.push(state),
    onTrayAction: sub(on.tray), onAuthCallback: sub(on.auth), onFullscreen: () => () => {}, fullscreenGet: async () => false,
    launchArgs: async () => options.launch ?? null,
    playFor: () => {}, preloadSounds: async () => {},
    defaultOrigin: ORIGIN, now: options.now ?? Date.now,
    openSignInWindow: async (url) => {
      if (options.window === "fails") throw new Error("no window")
      calls.windows.push(url)
    },
    closeSignInWindow: async () => void calls.closed++,
    onSignInClosed: sub(on.closed),
    onSignInRequest: sub(on.signIn), onSignOutRequest: sub(on.signOut),
    cli: { onInviteRequest: sub(on.invite), reportInvite: (report) => void calls.invites.push(report) },
    probe: async () => options.probe ?? 302,
    showToast: async (title, body) => void calls.toasts.push([title, body]),
    log: (level, message) => void calls.logs.push(`${level} ${message}`),
    autoInstall: { get: () => options.autoInstall ?? true, onChange: () => () => {} },
    updater: {
      configure: async (feed, auto) => void calls.configured.push([feed, auto]),
      install: async () => void calls.installed++,
      checkNow: async () => {},
      checkManual: async () => {
        calls.manualChecks++
        return options.manualCheck ?? { state: "none" }
      },
      onState: sub(on.update),
      afterUpdate: async () => after,
    },
    local: {
      get: async () => localState,
      onState: sub(on.localState),
      onUpdated: sub(on.localUpdated),
      retry: async () => {
        calls.retries++
        return options.retryProblem ?? null
      },
    },
    voice: {
      ready: async () => {},
      button: () => voice.button,
      speaks: () => voice.speaks,
      start: async () => void calls.voiceStarts++,
    },
    notchHidden: () => options.hidden ?? false,
    onEncryptionRequest: sub(on.encryption),
    reportEncryption: (report) => void calls.encryption.push(report),
    releaseOrigin: "https://release.example.com",
  }
  const make = () => {
    const app = new OwnerApp(ports)
    apps.push(app)
    return app
  }
  return { server, secrets, prefs, calls, on, ports, make, localState, voice, afterUpdate: (value: typeof after) => { after = value } }
}
type Harness = ReturnType<typeof harness>

const stateOf = (url: string) => new URL(url).searchParams.get("state")!
const callbackFor = (url: string, extra = `code=${CODE}`) => `relo://auth/callback?${extra}&state=${stateOf(url)}`
const fire = (h: Harness, url: string) => h.on.auth.forEach((cb) => cb(url))

async function beginSignIn(h: Harness) {
  const app = h.make()
  await app.start()
  await app.signIn()
  const url = h.calls.windows.at(-1)!
  h.server.codeChallenge = new URL(url).searchParams.get("code_challenge")
  return { app, url }
}

describe("sign-in in the app's own window", () => {
  it("opens the server's page for this PC and finishes when Rust hands over the callback", async () => {
    const h = harness()
    const { app, url } = await beginSignIn(h)
    expect(new URL(url).pathname).toBe("/mobile/sign-in")
    expect(new URL(url).searchParams.get("device")).toBe("windows")
    expect(app.getView().connection).toBe("signingIn")
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(app.getView().connection).toBe("live"))
    expect(app.getView()).toMatchObject({ failure: null, accountEmail: "ada@example.com" })
    expect(h.calls.closed).toBeGreaterThan(0)
    expect(h.calls.browser).toEqual([])
  })

  it("asks again without `device` when the server does not know it yet (400), and still signs in", async () => {
    const h = harness({ probe: 400 })
    const { app, url } = await beginSignIn(h)
    expect(new URL(url).searchParams.has("device")).toBe(false)
    expect(h.calls.logs.some((l) => l.includes("device=windows"))).toBe(true)
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(app.getView().connection).toBe("live"))
  })

  it("uses the system browser only when the window cannot open", async () => {
    const h = harness({ window: "fails" })
    const app = h.make()
    await app.start()
    await app.signIn()
    expect(h.calls.browser).toHaveLength(1)
    expect(h.calls.browser[0]).toContain("/mobile/sign-in")
    expect(app.getView().connection).toBe("signingIn")
  })

  it("cancels when the owner closes the window", async () => {
    const h = harness()
    const { app } = await beginSignIn(h)
    h.on.closed.forEach((cb) => cb())
    expect(app.getView().connection).toBe("signedOut")
    expect(app.getView().failure).toBeNull()
  })

  it("keeps the attempt across a page reload: the callback still completes (the hang)", async () => {
    const h = harness()
    const { url } = await beginSignIn(h) // the notch page is about to reload before the callback arrives
    h.on.auth.length = 0
    const reloaded = h.make()
    await reloaded.start()
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(reloaded.getView().connection).toBe("live"))
  })

  it("opens the same page again, not a new attempt, when asked while signing in", async () => {
    const h = harness()
    const { app, url } = await beginSignIn(h)
    await app.signIn()
    expect(h.calls.windows).toHaveLength(2)
    expect(stateOf(h.calls.windows[1]!)).toBe(stateOf(url))
  })

  it("handles one callback delivered twice once", async () => {
    const h = harness()
    const { app, url } = await beginSignIn(h)
    fire(h, callbackFor(url))
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(app.getView().connection).toBe("live"))
    expect(h.server.count("POST", "/api/mobile/sign-in/token")).toBe(1)
    expect(app.getView().failure).toBeNull()
  })
})

describe("a failed sign-in is seen, logged and can be retried", () => {
  it("shows the refused code in the notch (peek), logs it, flags the tray, and a second attempt works", async () => {
    const h = harness()
    const app = h.make()
    await app.start()
    await app.signIn()
    const url = h.calls.windows.at(-1)!
    // the server never issued this code: invalid_grant
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(app.getView().failure).toContain("expired"))
    expect(app.getView()).toMatchObject({ connection: "signedOut", peek: { kind: "failure" } })
    expect(h.calls.logs.some((l) => l.startsWith("error ") && l.includes("sign-in"))).toBe(true)
    expect(h.calls.logs.join("\n")).not.toContain(CODE)

    await app.signIn()
    const again = h.calls.windows.at(-1)!
    expect(stateOf(again)).not.toBe(stateOf(url))
    expect(app.getView().failure).toBeNull()
    h.server.codeChallenge = new URL(again).searchParams.get("code_challenge")
    fire(h, callbackFor(again, `code=${CODE}`))
    await vi.waitFor(() => expect(app.getView().connection).toBe("live"))
  })

  it("says so when a callback arrives with no sign-in open, instead of staying silent", async () => {
    const h = harness()
    const app = h.make()
    await app.start()
    fire(h, `relo://auth/callback?code=${CODE}&state=${"s".repeat(43)}`)
    await vi.waitFor(() => expect(app.getView().failure).toContain("Sign in again"))
    expect(app.getView().peek?.kind).toBe("failure")
  })

  it("ignores a link from another attempt while a real one is open", async () => {
    const h = harness()
    const { app, url } = await beginSignIn(h)
    fire(h, `relo://auth/callback?code=${CODE}&state=${"x".repeat(43)}`)
    await vi.waitFor(() => expect(h.calls.logs.some((l) => l.includes("another attempt"))).toBe(true))
    expect(app.getView()).toMatchObject({ connection: "signingIn", failure: null })
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(app.getView().connection).toBe("live"))
  })

  it("says when the server cannot be reached while finishing", async () => {
    const h = harness({ fetch: (inner) => async (input, init) => { if (input.includes("/api/mobile/sign-in/token")) throw new TypeError("offline"); return inner(input, init) } })
    const app = h.make()
    await app.start()
    await app.signIn()
    const url = h.calls.windows.at(-1)!
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(app.getView().failure).toContain("unreachable"))
  })
})

describe("installer hand-off", () => {
  it("signs in with the launch code and verifier without any window", async () => {
    const pkce = await createPkce()
    const server = new FakeServer()
    server.codeChallenge = pkce.challenge
    const h = harness({ server, launch: { origin: ORIGIN, signInCode: CODE, codeVerifier: pkce.verifier } })
    const app = h.make()
    await app.start()
    await vi.waitFor(() => expect(app.getView().connection).toBe("live"))
    expect(h.calls.windows).toEqual([])
    expect(app.getView().accountEmail).toBe("ada@example.com")
  })

  it("only remembers the server when the launch carries no code", async () => {
    const h = harness({ launch: { origin: "https://other.example.com", signInCode: null, codeVerifier: null } })
    const app = h.make()
    await app.start()
    expect(app.getView()).toMatchObject({ connection: "signedOut", serverOrigin: "https://other.example.com" })
  })
})

describe("signed-in flows", () => {
  async function signedIn(h: Harness) {
    const { app, url } = await beginSignIn(h)
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(app.getView().connection).toBe("live"))
    return app
  }

  it("a refused credential becomes needsSignIn, peeks, and the tray offers Sign in again", async () => {
    const h = harness()
    const app = await signedIn(h)
    h.server.nowStatus = 401
    app.store.refreshNow()
    await vi.waitFor(() => expect(app.getView().connection).toBe("needsSignIn"))
    expect(app.getView().peek?.kind).toBe("signedOut")
    expect(h.calls.trays.at(-1)).toMatchObject({ status: "signedOut", needsSignIn: true })
  })

  it("signs out from the tray, forgets the credential, and another account can sign in", async () => {
    const h = harness()
    const app = await signedIn(h)
    h.on.tray.forEach((cb) => cb("sign_out"))
    await vi.waitFor(() => expect(app.getView().connection).toBe("signedOut"))
    expect(await h.secrets.get("relo.owner.device")).toBeNull()
    expect(app.getView()).toMatchObject({ summary: null, waitingComputers: [], failure: null })

    await app.signIn()
    const url = h.calls.windows.at(-1)!
    h.server.session = "second-account-session"
    h.server.codeChallenge = new URL(url).searchParams.get("code_challenge")
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(app.getView().connection).toBe("live"))
  })

  it("signs in when Settings or the onboarding ask (settings_sign_in / onboarding_sign_in), with the server they chose", async () => {
    const h = harness()
    const app = h.make()
    await app.start()
    expect(h.on.signIn).toHaveLength(1)
    h.on.signIn.forEach((cb) => cb("https://relo.example.com"))
    await vi.waitFor(() => expect(app.getView().connection).toBe("signingIn"))
    expect(app.getView().serverOrigin).toBe("https://relo.example.com")
    expect(h.calls.windows.at(-1)).toContain("https://relo.example.com/mobile/sign-in")
  })

  it("signs in with the remembered server when the request names none", async () => {
    const h = harness()
    const app = h.make()
    await app.start()
    h.on.signIn.forEach((cb) => cb(null))
    await vi.waitFor(() => expect(app.getView().connection).toBe("signingIn"))
    expect(app.getView().serverOrigin).toBe(ORIGIN)
  })

  it("says the address is not valid in the Mac's words, and does not open a window", async () => {
    const h = harness()
    const app = h.make()
    await app.start()
    await app.signIn("not an address at all :::")
    expect(app.getView().problem).toBe("That server address is not valid.")
    expect(h.calls.windows).toEqual([])
  })

  it("signs out when Settings asks (settings_sign_out)", async () => {
    const h = harness()
    const app = await signedIn(h)
    h.on.signOut.forEach((cb) => cb())
    await vi.waitFor(() => expect(app.getView().connection).toBe("signedOut"))
    expect(await h.secrets.get("relo.owner.device")).toBeNull()
  })

  it("makes the relo command's one-time code when the onboarding asks, for this server only", async () => {
    const invite = `rci_${"B".repeat(32)}`
    const asked: Array<{ url: string; auth: string | null }> = []
    const h = harness({
      fetch: (inner) => async (url, init) => {
        if (!url.endsWith("/api/devices/self/computer-invites")) return inner(url, init)
        asked.push({ url, auth: new Headers(init?.headers).get("authorization") })
        return new Response(JSON.stringify({ code: invite, expiresAt: "2030-01-01T00:00:00.000Z" }), { status: 201 })
      },
    })
    await signedIn(h)
    h.on.invite.forEach((cb) => cb({ id: "req-1", origin: ORIGIN }))
    await vi.waitFor(() => expect(h.calls.invites).toHaveLength(1))
    expect(h.calls.invites[0]).toEqual({ id: "req-1", code: invite })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.auth).toMatch(/^Bearer \S+/)
    // A server the app is not signed in to gets no request and a plain-words answer; the code is never logged.
    h.on.invite.forEach((cb) => cb({ id: "req-2", origin: "https://other.example.com" }))
    await vi.waitFor(() => expect(h.calls.invites).toHaveLength(2))
    expect(h.calls.invites[1]).toEqual({ id: "req-2", problem: "Relo could not ask your server for a one-time code. Sign in again, then try again." })
    expect(asked).toHaveLength(1)
    expect(h.calls.logs.join("\n")).not.toContain(invite)
  })

  it("tells the onboarding in plain words when the server makes no code", async () => {
    const h = harness()
    await signedIn(h)
    h.on.invite.forEach((cb) => cb({ id: "req-1", origin: ORIGIN }))
    await vi.waitFor(() => expect(h.calls.invites).toHaveLength(1))
    expect(h.calls.invites[0]).toEqual({ id: "req-1", problem: "Your server did not give Relo a one-time code. Try again." })
  })

  it("names the browser only when it had to use it", async () => {
    const window = harness()
    const inWindow = window.make()
    await inWindow.start()
    await inWindow.signIn()
    expect(inWindow.getView().signInInBrowser).toBe(false)
    const fallback = harness({ window: "fails" })
    const inBrowser = fallback.make()
    await inBrowser.start()
    await inBrowser.signIn()
    expect(inBrowser.getView().signInInBrowser).toBe(true)
    inBrowser.cancelSignIn()
    expect(inBrowser.getView().signInInBrowser).toBe(false)
  })

  it("dismisses a missed question on the server (POST /api/devices/self/questions/:id/dismiss) and reads Now again", async () => {
    const h = harness()
    const app = await signedIn(h)
    const reads = h.server.count("GET", "/api/now")
    await expect(app.dismissMissed(INTERACTION)).resolves.toBe(true)
    expect(h.server.count("POST", `/api/devices/self/questions/${INTERACTION}/dismiss`)).toBe(1)
    await vi.waitFor(() => expect(h.server.count("GET", "/api/now")).toBeGreaterThan(reads))
    h.server.dismissStatus = 500
    await expect(app.dismissMissed(INTERACTION)).resolves.toBe(false)
  })

  it("switching account signs out and opens the sign-in again", async () => {
    const h = harness()
    const app = await signedIn(h)
    const before = h.calls.windows.length
    await app.switchAccount()
    expect(h.calls.windows.length).toBe(before + 1)
    expect(app.getView().connection).toBe("signingIn")
  })

  it("announces a fresh notice once as a peek, and as a toast only when the notch is hidden (a full-screen app)", async () => {
    const h = harness({ hidden: true })
    h.server.devicesList = []
    h.server.current = { items: [notice(1)], retired: [], total: 1, cursor: null, hasMore: false, counts: { actionable: 0, currentUnread: 1 }, nextExpiryAt: null, serverTime: "2026-10-14T10:00:30.000Z" }
    const app = await signedIn(h)
    await vi.waitFor(() => expect(h.calls.toasts).toEqual([["Notice 1", "First line"]]))
    expect(app.getView()).toMatchObject({ peek: { kind: "notice" }, arrivals: [expect.objectContaining({ title: "Notice 1" })] })
    app.store.refreshNow()
    await new Promise((r) => setTimeout(r, 50))
    expect(h.calls.toasts).toHaveLength(1)
  })

  it("shows a notice in the notch alone (no toast) while the notch is on screen", async () => {
    const h = harness({ hidden: false })
    h.server.devicesList = []
    h.server.current = { items: [notice(1)], retired: [], total: 1, cursor: null, hasMore: false, counts: { actionable: 0, currentUnread: 1 }, nextExpiryAt: null, serverTime: "2026-10-14T10:00:30.000Z" }
    const app = await signedIn(h)
    await vi.waitFor(() => expect(app.getView().arrivals).toHaveLength(1))
    expect(app.getView().peek?.kind).toBe("notice")
    expect(h.calls.toasts).toEqual([])
  })

  it("stays quiet about notices when an iPhone gets the push", async () => {
    const h = harness()
    h.server.devicesList = [{ trusted: true, isCurrent: false, ownerOverview: false, isSimulator: false }]
    h.server.current = { items: [notice(1)], retired: [], total: 1, cursor: null, hasMore: false, counts: { actionable: 0, currentUnread: 1 }, nextExpiryAt: null, serverTime: "2026-10-14T10:00:30.000Z" }
    const app = await signedIn(h)
    await new Promise((r) => setTimeout(r, 100))
    expect(h.calls.toasts).toEqual([])
    expect(app.getView().arrivals).toEqual([])
  })
})

describe("updates", () => {
  it("looks at the server's own feed, follows the auto-install setting, and the public feed for a loopback server", async () => {
    const h = harness()
    const app = h.make()
    await app.start()
    expect(h.calls.configured.at(-1)).toEqual([`${ORIGIN}/windows/update.json`, true])
    await app.store.setServerOrigin("http://127.0.0.1:8180")
    h.on.update.forEach((cb) => cb({ state: "none" }))
    // The origin change reaches Rust on the next state change.
    app.store.getState()
    expect(h.calls.configured.length).toBeGreaterThanOrEqual(1)
  })

  it("shows a waiting update, snoozes it for a day for that version only, and installs on Restart now", async () => {
    const h = harness()
    const app = h.make()
    await app.start()
    h.on.update.forEach((cb) => cb({ state: "ready", version: "0.2.0" }))
    expect(app.getView().update).toEqual({ version: "0.2.0", ready: true })
    expect(app.getView().peek?.kind).toBe("update")
    app.later()
    expect(app.getView().update).toBeNull()
    h.on.update.forEach((cb) => cb({ state: "ready", version: "0.2.1" }))
    expect(app.getView().update).toEqual({ version: "0.2.1", ready: true })
    h.on.tray.forEach((cb) => cb("update_install"))
    await vi.waitFor(() => expect(h.calls.installed).toBe(1))
    expect(h.calls.trays.at(-1)).toMatchObject({ updateVersion: "0.2.1", updateReady: true })
  })

  it("says what happened after an update, for ten seconds from the first time the notch opens", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const h = harness()
      h.afterUpdate({ version: "0.2.0", agents: "notApplicable" })
      const app = h.make()
      await app.start()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(app.getView().updatedLine).toBeNull() // launched, not opened: nothing shows yet
      expect(app.getView().peek).toBeNull()
      app.viewChanged(true)
      expect(app.getView().updatedLine).toBe("Updated to 0.2.0")
      await vi.advanceTimersByTimeAsync(9_000)
      expect(app.getView().updatedLine).toBe("Updated to 0.2.0")
      await vi.advanceTimersByTimeAsync(1_500)
      expect(app.getView().updatedLine).toBeNull()
      app.viewChanged(true) // once
      expect(app.getView().updatedLine).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a Later across a restart, and shows the update again once the day is over", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      let now = 1_000_000
      const prefs = memoryStore()
      const first = harness({ prefs, now: () => now })
      const app = first.make()
      await app.start()
      first.on.update.forEach((cb) => cb({ state: "available", version: "0.3.0" }))
      app.later()
      expect(app.getView().update).toBeNull()
      expect(JSON.parse((await prefs.get("relo.update.snooze"))!)).toEqual({ version: "0.3.0", until: 1_000_000 + 24 * 3_600_000 })
      app.stop()

      const second = harness({ prefs, server: first.server, now: () => now })
      const again = second.make()
      await again.start()
      second.on.update.forEach((cb) => cb({ state: "available", version: "0.3.0" }))
      expect(again.getView().update).toBeNull() // still snoozed after the restart
      expect(second.calls.trays.at(-1)).toMatchObject({ updateVersion: "0.3.0", updateReady: false }) // the tray still lists it
      now += 24 * 3_600_000 + 2_000
      await vi.advanceTimersByTimeAsync(24 * 3_600_000 + 2_000)
      expect(again.getView().update).toEqual({ version: "0.3.0", ready: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the update in the tray while the notch's reminder is snoozed", async () => {
    const h = harness()
    const app = h.make()
    await app.start()
    h.on.update.forEach((cb) => cb({ state: "ready", version: "0.2.0" }))
    app.later()
    expect(app.getView().update).toBeNull()
    expect(h.calls.trays.at(-1)).toMatchObject({ updateVersion: "0.2.0", updateReady: true })
  })

  it("checks for updates when the tray asks, and says when there is nothing", async () => {
    const h = harness({ manualCheck: { state: "none" } })
    const app = h.make()
    await app.start()
    h.on.tray.forEach((cb) => cb("check_updates"))
    await vi.waitFor(() => expect(h.calls.toasts).toEqual([["Relo", "Relo is up to date."]]))
    expect(h.calls.manualChecks).toBe(1)
    const failing = harness({ manualCheck: { state: "error", message: "x" } })
    const other = failing.make()
    await other.start()
    failing.on.tray.forEach((cb) => cb("check_updates"))
    await vi.waitFor(() => expect(failing.calls.toasts).toEqual([["Relo", "Relo could not check for updates."]]))
  })
})

describe("Relo on this PC", () => {
  const RUNNING: LocalState = { mode: true, bundled: true, phase: "running", reason: null, port: 8180, version: "0.2.0" }

  it("shows 'Updated to X · agents refreshed' from local_updated, when the notch first opens", async () => {
    const h = harness({ local: RUNNING })
    const app = h.make()
    await app.start()
    h.on.localUpdated.forEach((cb) => cb({ version: "0.2.0", agents: "refreshed" }))
    expect(app.getView().updatedLine).toBeNull()
    app.viewChanged(true)
    expect(app.getView().updatedLine).toBe("Updated to 0.2.0 · agents refreshed")
    h.on.localUpdated.forEach((cb) => cb({ version: "0.2.1", agents: "failed" }))
    expect(app.getView().updatedLine).toBe("Updated to 0.2.1 · agents not refreshed: Set up agents again in Settings")
  })

  it("tells the tray it is local, starting, or could not start (and Try again starts it)", async () => {
    const h = harness({ local: { ...RUNNING, phase: "starting" }, retryProblem: "Relo could not start." })
    const app = h.make()
    await app.start()
    expect(app.getView()).toMatchObject({ local: true, localStarting: true, localStartFailed: false })
    expect(h.calls.trays.at(-1)).toMatchObject({ local: true, status: "starting", connecting: false })
    h.on.localState.forEach((cb) => cb({ ...RUNNING, phase: "failed", reason: "x" }))
    expect(app.getView().localStartFailed).toBe(true)
    expect(h.calls.trays.at(-1)).toMatchObject({ local: true, localFailed: true })
    h.on.tray.forEach((cb) => cb("retry_start"))
    await vi.waitFor(() => expect(h.calls.retries).toBe(1))
    await vi.waitFor(() => expect(app.getView().problem).toBe("Relo could not start."))
  })
})

describe("the last Now (local mode)", () => {
  const RUNNING: LocalState = { mode: true, bundled: true, phase: "running", reason: null, port: 8180, version: "0.2.0" }

  it("draws a cached Now (at most ten minutes old) while connecting, flags it, and drops the flag for the answer", async () => {
    const server = new FakeServer()
    const prefs = memoryStore()
    // A signed-in PC from an earlier run, then a launch where the server does not answer yet.
    const earlier = harness({ server, prefs, local: RUNNING })
    const signed = earlier.make()
    await signed.start()
    await signed.signIn()
    const url = earlier.calls.windows.at(-1)!
    server.codeChallenge = new URL(url).searchParams.get("code_challenge")
    fire(earlier, callbackFor(url))
    await vi.waitFor(() => expect(signed.getView().connection).toBe("live"))
    await vi.waitFor(async () => expect(await prefs.get("relo.nowCache")).not.toBeNull())
    signed.stop()

    const later = harness({ server, prefs, secrets: earlier.secrets, local: RUNNING, fetch: (inner) => async (input, init) => (input.includes("/api/now") ? new Promise<Response>(() => {}) : inner(input, init)) })
    const relaunched = later.make()
    await relaunched.start()
    expect(relaunched.getView()).toMatchObject({ cached: true, connection: "connecting" })
    expect(relaunched.getView().summary).not.toBeNull()
    expect(relaunched.getView().updatedAt).toBeNull() // "Live · time" is the server's, not the cache's
  })

  it("ignores a cache older than ten minutes", async () => {
    const server = new FakeServer()
    const prefs = memoryStore()
    const earlier = harness({ server, prefs, local: RUNNING })
    const signed = earlier.make()
    await signed.start()
    await signed.signIn()
    const url = earlier.calls.windows.at(-1)!
    server.codeChallenge = new URL(url).searchParams.get("code_challenge")
    fire(earlier, callbackFor(url))
    await vi.waitFor(() => expect(signed.getView().connection).toBe("live"))
    await vi.waitFor(async () => expect(await prefs.get("relo.nowCache")).not.toBeNull())
    signed.stop()

    const later = harness({ server, prefs, secrets: earlier.secrets, local: RUNNING, now: () => Date.now() + 601_000, fetch: (inner) => async (input, init) => (input.includes("/api/now") ? new Promise<Response>(() => {}) : inner(input, init)) })
    const relaunched = later.make()
    await relaunched.start()
    expect(relaunched.getView()).toMatchObject({ cached: false, summary: null })
  })

  it("is not kept or drawn for a server (cards there are sealed)", async () => {
    const server = new FakeServer()
    const prefs = memoryStore()
    const h = harness({ server, prefs })
    const app = h.make()
    await app.start()
    await app.signIn()
    const url = h.calls.windows.at(-1)!
    server.codeChallenge = new URL(url).searchParams.get("code_challenge")
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(app.getView().connection).toBe("live"))
    expect(await prefs.get("relo.nowCache")).toBeNull()
  })

  it("is dropped at sign-out", async () => {
    const server = new FakeServer()
    const prefs = memoryStore()
    const h = harness({ server, prefs, local: RUNNING })
    const app = h.make()
    await app.start()
    await app.signIn()
    const url = h.calls.windows.at(-1)!
    server.codeChallenge = new URL(url).searchParams.get("code_challenge")
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(app.getView().connection).toBe("live"))
    await vi.waitFor(async () => expect(await prefs.get("relo.nowCache")).not.toBeNull())
    await app.signOut()
    expect(await prefs.get("relo.nowCache")).toBeNull()
  })
})

describe("the voice at launch", () => {
  it("starts right away when the mode speaks", async () => {
    const h = harness({ voice: { speaks: true } })
    await h.make().start()
    await vi.waitFor(() => expect(h.calls.voiceStarts).toBe(1))
  })

  it("starts after 30 s with sound only, and never without the voice button", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const h = harness({ voice: { speaks: false } })
      await h.make().start()
      await vi.advanceTimersByTimeAsync(29_000)
      expect(h.calls.voiceStarts).toBe(0)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(h.calls.voiceStarts).toBe(1)

      const off = harness({ voice: { button: false, speaks: true } })
      await off.make().start()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(off.calls.voiceStarts).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("Settings' encryption policy", () => {
  async function liveServer() {
    const h = harness()
    const app = h.make()
    await app.start()
    await app.signIn()
    const url = h.calls.windows.at(-1)!
    h.server.codeChallenge = new URL(url).searchParams.get("code_challenge")
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(app.getView().connection).toBe("live"))
    return { h, app }
  }
  const ask = (h: Harness, request: EncryptionRequest) => h.on.encryption.forEach((cb) => cb(request))

  it("reads the account's policy from the server when Settings asks, and reports it", async () => {
    const { h } = await liveServer()
    h.server.devicesList = [{ trusted: true, isCurrent: false }]
    ask(h, { action: "refresh" })
    await vi.waitFor(() => expect(h.calls.encryption.at(-1)).toEqual({ mode: "auto", phoneTrusted: true, problem: null, busy: false }))
    expect(h.server.count("GET", "/api/end-to-end/policy")).toBe(1)
  })

  it("changes the policy on the server, busy while it does, and reports an error in the Mac's words", async () => {
    const { h } = await liveServer()
    ask(h, { action: "set", always: true })
    await vi.waitFor(() => expect(h.calls.encryption.at(-1)).toMatchObject({ mode: "on", problem: null, busy: false }))
    expect(h.calls.encryption.some((r) => r.busy)).toBe(true)
    expect(h.server.seen.filter((s) => s.method === "PUT" && s.path === "/api/end-to-end/policy").map((s) => s.body)).toEqual([{ required: true }])
    h.server.policyStatus = 500
    ask(h, { action: "set", always: false })
    await vi.waitFor(() => expect(h.calls.encryption.at(-1)).toMatchObject({ problem: "Relo could not change that. Try again.", busy: false }))
  })

  it("opens the Dashboard's security page, and reports no policy for Relo on this PC", async () => {
    const { h } = await liveServer()
    ask(h, { action: "open_security" })
    await vi.waitFor(() => expect(h.calls.browser.at(-1)).toBe(`${ORIGIN}/dashboard/account#security`))
    const local = harness({ local: { mode: true, bundled: true, phase: "running", reason: null, port: 8180, version: "0.2.0" } })
    await local.make().start()
    ask(local, { action: "refresh" })
    expect(local.calls.encryption.at(-1)).toMatchObject({ mode: null })
    expect(local.server.count("GET", "/api/end-to-end/policy")).toBe(0)
  })

  it("opens <origin>/dashboard from the tray's Open Dashboard", async () => {
    const { h } = await liveServer()
    h.on.tray.forEach((cb) => cb("open_dashboard"))
    await vi.waitFor(() => expect(h.calls.browser.at(-1)).toBe(`${ORIGIN}/dashboard`))
  })
})

describe("the tray's picture", () => {
  it("carries the account, the first title, whether an address exists, and a connecting state", async () => {
    const h = harness()
    const app = h.make()
    await app.start()
    expect(h.calls.trays.at(-1)).toMatchObject({ hasOrigin: true, email: null, firstTitle: null })
    await app.signIn()
    const url = h.calls.windows.at(-1)!
    h.server.codeChallenge = new URL(url).searchParams.get("code_challenge")
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(h.calls.trays.at(-1)).toMatchObject({ status: "live", email: "ada@example.com", connecting: false }))
    expect(h.calls.trays.at(-1)!.needsYou).toBeGreaterThanOrEqual(0)
  })

  it("logs the Mac's lines: counts for Now, never titles", async () => {
    const h = harness()
    const app = h.make()
    await app.start()
    await app.signIn()
    const url = h.calls.windows.at(-1)!
    h.server.codeChallenge = new URL(url).searchParams.get("code_challenge")
    fire(h, callbackFor(url))
    await vi.waitFor(() => expect(h.calls.logs.some((l) => /^info now: needsYou=\d+ running=\d+ recent=\d+ yourTurn=\d+ quiet=\d+ sessions=\d+ focus=(true|false)$/.test(l))).toBe(true))
    await vi.waitFor(() => expect(h.calls.logs.some((l) => /^info notices: current=\d+ new=\d+$/.test(l))).toBe(true))
  })
})
