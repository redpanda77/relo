// Relo for Windows as a live owner device: the OwnerStore wired to this PC. Everything platform-specific enters through
// `Ports` (the Rust bridge in the app, fakes in tests); the rules (what the tray says, when a sound plays, what a
// tray action does, how sign-in ends and how it fails) live here.
//
// Sign-in (the Mac's BrowserSignInSession): a window titled "Sign in to Relo" loads the server's page; Rust catches the
// `relo://auth/callback` redirect and hands it over as `auth_callback`. The attempt (PKCE state and verifier) is kept in
// the store's secrets, not only in memory, so a page reload between "approve" and the callback loses nothing. Every
// failure is logged and shown in the notch, which opens by itself, with a way to try again.

import type { NowSummary } from "@relo/notification-contracts"
import { OwnerClientError, OwnerStore, type DeviceInfo, type OwnerNotice, type OwnerState } from "@relo/owner-client"
import { indexedDbStore, type KeyValueStore } from "@relo/owner-crypto"
import * as bridge from "../bridge"
import { localRepair, localRetryStart, localStateGet, OFF, onLocalState, onLocalUpdated, type LocalState } from "../local/api"
import { attachLocal } from "../local/notchLocal"
import type { AnswerAction, AnswerPhase, OnAnswer, QuestionSpec } from "../relo/answers"
import { eventsBetween } from "../relo/events"
import { presentationOf, type Presentation, type SpokenWordsById } from "../relo/presentation"
import { settingsStore } from "../settings/store"
import { cuePlayer, quiet } from "../sound"
import { start as startVoiceEngine } from "../voice/ipc"
import { inviteProblem, type InviteReport, type InviteRequest } from "./cliInvite"
import * as native from "./native"
import { clearNowCache, loadNowCache, saveNowCache } from "./nowCache"
import { createOwnerCrypto, type PcOwnerCrypto, type WaitingComputer } from "./ownerCrypto"
import { createPrefsStore, createSecretStore } from "./stores"
import { appFetch } from "./transport"
import { isLoopback, isSnoozed, parseSnooze, RELEASE_ORIGIN, snoozedUntil, updateFeedUrl, updatedLine, type Snooze } from "./updatePolicy"
import { answerPhases, approvalOf, notificationsByInteraction, questionSpecs, trayStateOf } from "./view"

const HOUR_MS = 3_600_000
const HEARTBEAT_MS = 6 * HOUR_MS
const WAITING_RECHECK_MS = 120_000
const SNOOZE_PREF = "relo.update.snooze"
/** The same callback delivered twice (the OS and the window) is handled once. */
const DUPLICATE_MS = 15_000
const UPDATED_LINE_MS = 10_000
/** ReloVoice: spoken moments start the voice right away; with sound only it waits so the first minutes are the owner's. */
const VOICE_SOUND_ONLY_DELAY_MS = 30_000

export interface Ports {
  fetch: typeof appFetch
  secrets: ReturnType<typeof createSecretStore>
  prefs: ReturnType<typeof createPrefsStore>
  keys: KeyValueStore
  device: () => Promise<DeviceInfo>
  openUrl: (url: string) => Promise<void>
  setTray: (state: bridge.TrayState) => Promise<void>
  onTrayAction: (cb: (action: bridge.TrayAction) => void) => () => void
  onAuthCallback: (cb: (url: string) => void) => () => void
  onFullscreen: (cb: (fullscreen: boolean) => void) => () => void
  fullscreenGet: () => Promise<boolean>
  launchArgs: () => Promise<bridge.LaunchArgs | null>
  /** Plays the cue for new moments; returns nothing the app needs. */
  playFor: (events: Array<{ kind: "question" | "failed" | "yourTurn" | "finished" | "started" | "progressed"; tone?: string }>) => void
  preloadSounds: () => Promise<void>
  /** The server address to use when neither the installer nor the owner chose one (a dev default). */
  defaultOrigin: string | null
  now: () => number
  /** "Sign in to Relo": a window on the server's page. Rejects when it cannot open (the browser is the fallback). */
  openSignInWindow: (url: string) => Promise<void>
  closeSignInWindow: () => Promise<void>
  onSignInClosed: (cb: () => void) => () => void
  /** Settings' and the onboarding's Sign in buttons (`settings_sign_in`, `onboarding_sign_in`): the server the owner chose, or null. */
  onSignInRequest: (cb: (origin: string | null) => void) => () => void
  /** Settings' Sign out (`settings_sign_out`). */
  onSignOutRequest: (cb: () => void) => () => void
  /** The onboarding's relo command asks for a one-time code to sign the CLI in with; the answer goes back to it (cliInvite.ts). */
  cli: { onInviteRequest: (cb: (request: InviteRequest) => void) => () => void; reportInvite: (report: InviteReport) => void }
  /** The HTTP status of the sign-in page (no redirects followed), or null when it could not be asked. */
  probe: (url: string) => Promise<number | null>
  showToast: (title: string, body: string) => Promise<void>
  log: (level: native.LogLevel, message: string) => void
  /** Settings the updater follows (settings/store.ts autoInstallUpdates). */
  autoInstall: { get: () => boolean; onChange: (cb: () => void) => () => void }
  updater: {
    configure: (feed: string | null, autoInstall: boolean) => Promise<void>
    install: () => Promise<void>
    checkNow: () => Promise<void>
    /** The owner's own check (the tray's "Check for Updates…"): the outcome, or null when it could not be asked. */
    checkManual: () => Promise<native.UpdateState | null>
    onState: (cb: (state: native.UpdateState) => void) => () => void
    afterUpdate: () => Promise<native.AfterUpdate | null>
  }
  /** Relo on this PC: where it stands (`local_state`), the "updated" report after the server was brought up to the app, and Try again. */
  local: {
    get: () => Promise<LocalState>
    onState: (cb: (state: LocalState) => void) => () => void
    onUpdated: (cb: (update: { version: string | null; agents: "refreshed" | "failed" }) => void) => () => void
    retry: () => Promise<string | null>
  }
  /** The voice (src/voice): started at launch when the owner's mode speaks, else 30 s later. */
  voice: { ready: () => Promise<void>; button: () => boolean; speaks: () => boolean; start: () => Promise<void> }
  /** Whether the notch cannot be seen right now (a full-screen app is in front): a notice then also becomes a toast. */
  notchHidden: () => boolean
  /** Settings' Encryption group: requests in, the policy out. */
  onEncryptionRequest: (cb: (request: native.EncryptionRequest) => void) => () => void
  reportEncryption: (report: native.EncryptionReport) => void
  /** Where the public release feed is (a local install or a server on this PC uses it). */
  releaseOrigin: string | null
}

/** What makes the open notch appear by itself for a moment (the Mac's peek). */
export type PeekKind = "notice" | "failure" | "signedOut" | "update" | "approval" | "updated"

/** What the notch draws and calls. Re-created on every change so React sees it. */
export interface OwnerView {
  connection: OwnerState["connection"]
  summary: NowSummary | null
  /** What each card says aloud (ADR 0015), by card id: `withSpoken` puts it on the rows; src/alerts speaks it. */
  spoken: SpokenWordsById
  questions: Record<string, QuestionSpec>
  answers: Record<string, AnswerPhase>
  offline: boolean
  problem: string | null
  /** Whether a trusted device approved this PC's keys (`owner_state` carries it to Settings). */
  approval: "waiting" | "approved" | null
  serverOrigin: string | null
  accountEmail: string | null
  /** The owner's sounds are paused until this time (epoch ms), or 0. */
  pausedUntil: number
  /** A sign-in that did not finish, in words, until the next attempt; the notch offers Sign in again. */
  failure: string | null
  /** Computers of the account this PC does not trust yet: approve or decline here. */
  waitingComputers: WaitingComputer[]
  /** An update that is waiting for the owner (not snoozed). */
  update: { version: string; ready: boolean } | null
  /** "Updated to X · agents refreshed", for a few seconds after an update. */
  updatedLine: string | null
  /** Notices that just arrived (this account has no phone that gets pushes). */
  arrivals: OwnerNotice[]
  /** Changes whenever the notch should open by itself; `kind` says why. */
  peek: { serial: number; kind: PeekKind } | null
  /** The sign-in page opened in the system browser because its own window could not open (the only time the notch says "browser"). */
  signInInBrowser: boolean
  /** When Now was last read (epoch ms), or null before the first answer: Home's "Live · 2:05 PM". */
  updatedAt: number | null
  /** The notices that arrived, newest first (the Recent list Home shows). */
  notices: OwnerNotice[]
  /** The Now on screen is the last one this PC read (local mode's launch cache) until the server answers: draw it dimmed. */
  cached: boolean
  /** Relo on this PC: it is being started or checked after launch (the notch says "Starting Relo…"), or it would not start. */
  localStarting: boolean
  localStartFailed: boolean
  /** Relo is running on this PC (local mode). */
  local: boolean
}

export class OwnerApp {
  readonly store: OwnerStore
  readonly crypto: PcOwnerCrypto
  private view: OwnerView
  private readonly listeners = new Set<() => void>()
  private readonly offs: Array<() => void> = []
  private previous: Presentation | null = null
  private lastSummary: NowSummary | null = null
  private pausedUntil = 0
  private pauseTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private started: Promise<void> | null = null
  private localProblem: string | null = null

  private failure: string | null = null
  private lastConnection: OwnerState["connection"] = "starting"
  private lastCallback: { url: string; at: number } | null = null
  private peekState: { serial: number; kind: PeekKind } | null = null
  private waiting: WaitingComputer[] = []
  private approvalTimer: ReturnType<typeof setTimeout> | null = null
  private noticeSerial = 0
  private arrivals: OwnerNotice[] = []
  private recentNotices: OwnerNotice[] = []
  private inBrowser = false
  private updatedAt: number | null = null
  private updateState: { version: string; ready: boolean } | null = null
  private snooze: Snooze | null = null
  private snoozeTimer: ReturnType<typeof setTimeout> | null = null
  private updated: string | null = null
  private updatedTimer: ReturnType<typeof setTimeout> | null = null
  private configuredFeed: string | null | undefined = undefined
  private configuredAuto: boolean | undefined = undefined
  private localState: LocalState = OFF
  /** The notch is open (the Relo view is on screen): the "Updated to …" line waits for the first time. */
  private notchOpen = false
  private pendingUpdated: string | null = null
  private voiceTimer: ReturnType<typeof setTimeout> | null = null
  private encryptionProblem: string | null = null
  private encryptionBusy = false
  /** What was last written to the Now cache, so an unchanged Now is not written again. */
  private cachedJson: string | null = null

  private readonly ports: Ports

  constructor(ports: Ports) {
    this.ports = ports
    this.crypto = createOwnerCrypto({ keys: ports.keys, secrets: ports.secrets, fetch: ports.fetch, now: ports.now })
    this.store = new OwnerStore({
      fetch: ports.fetch,
      secrets: ports.secrets,
      prefs: ports.prefs,
      crypto: this.crypto,
      device: placeholderDevice,
      now: ports.now,
      log: (message, error) => ports.log("error", error === undefined ? message : `${message}: ${describe(error)}`),
      note: (message) => ports.log("info", message),
    })
    this.view = this.compute(this.store.getState())
  }

  getView = (): OwnerView => this.view

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Starts once: restores the credential, wires the tray, sounds and sign-in callback. */
  start(): Promise<void> {
    this.started ??= this.run()
    return this.started
  }

  private async run(): Promise<void> {
    const { ports, store } = this
    // The device record the server sees (name, versions) is known only asynchronously; the store reads it at register.
    const device = await ports.device().catch(() => placeholderDevice)
    Object.assign(placeholderDevice, device)

    // Where Relo on this PC stands, before anything reads it (the Now cache and the tray's words depend on it).
    this.localState = await ports.local.get().catch(() => OFF)

    // Listeners first: a callback or a closed window can arrive while the rest is still starting.
    this.offs.push(ports.local.onState((state) => this.onLocalState(state)))
    this.offs.push(ports.local.onUpdated((update) => this.localUpdated(update)))
    this.offs.push(ports.onEncryptionRequest((request) => void this.onEncryptionRequest(request)))
    this.offs.push(store.subscribe((state) => this.onState(state)))
    this.offs.push(ports.onAuthCallback((url) => void this.completeSignIn(url)))
    this.offs.push(ports.onSignInClosed(() => this.signInWindowClosed()))
    this.offs.push(ports.onTrayAction((action) => void this.onTrayAction(action)))
    // The Settings window and the onboarding sign this PC in and out through the notch, which owns the connection.
    this.offs.push(ports.onSignInRequest((origin) => void this.signIn(origin ?? undefined)))
    this.offs.push(ports.onSignOutRequest(() => void this.signOut()))
    this.offs.push(ports.cli.onInviteRequest((request) => void this.makeInvite(request)))
    this.offs.push(attachLocal(this))
    this.offs.push(ports.onFullscreen((fullscreen) => { quiet.fullscreen = fullscreen }))
    this.offs.push(ports.updater.onState((state) => this.onUpdateState(state)))
    this.offs.push(ports.autoInstall.onChange(() => this.configureUpdates()))
    void ports.fullscreenGet().then((fullscreen) => { quiet.fullscreen = fullscreen })
    void ports.preloadSounds()
    if (typeof window !== "undefined") {
      const wake = () => store.refreshNow()
      window.addEventListener("online", wake)
      this.offs.push(() => window.removeEventListener("online", wake))
    }

    await this.loadSnooze()
    await store.start()
    await this.seedFromCache()
    await this.chooseOrigin()
    this.heartbeat = setInterval(() => void store.sendHeartbeat().catch(() => undefined), HEARTBEAT_MS)
    this.onState(store.getState())
    this.configureUpdates()
    void this.announceUpdated()
    void this.startVoiceAtLaunch()
  }

  /** The onboarding's request for the relo command's sign-in code: made with this PC's own credential, for this server only. */
  private async makeInvite(request: InviteRequest): Promise<void> {
    try {
      const code = await this.store.createComputerInvite(request.origin)
      this.ports.cli.reportInvite({ id: request.id, code })
    } catch (error) {
      // The code is never logged; the failure is, without it.
      this.ports.log("warn", `computer invite for the relo command failed: ${describe(error)}`)
      this.ports.cli.reportInvite({ id: request.id, problem: inviteProblem(error) })
    }
  }

  /** Relo on this PC is on (or being set up): the words, the Now cache and the tray follow it. */
  get isLocal(): boolean {
    return this.localState.mode
  }

  private onLocalState(state: LocalState): void {
    const was = this.localState
    this.localState = state
    if (!state.mode && was.mode) void clearNowCache(this.ports.prefs)
    this.publish()
  }

  /** local_updated: the server was brought up to the app's release and the agents' files refreshed or not ("Updated to X · agents refreshed"). */
  private localUpdated(update: { version: string | null; agents: "refreshed" | "failed" }): void {
    this.queueUpdated(updatedLine(update.version || placeholderDevice.appVersion, update.agents))
  }

  /**
   * Local mode, at launch: draws the last Now this PC read (up to ten minutes old) while the server is still answering for
   * the first time (the Mac's `start`). Not when the install hands this PC to a server of the owner's.
   */
  private async seedFromCache(): Promise<void> {
    if (!this.localState.mode) return
    const launched = await this.ports.launchArgs().catch(() => null)
    if (launched?.origin && !isLoopback(launched.origin)) return
    const cached = await loadNowCache(this.ports.prefs, this.ports.now())
    if (cached && this.store.seedCached(cached)) this.cachedJson = JSON.stringify(cached)
  }

  /** After a Now was read in local mode: keep it for the next launch (the Mac writes it when it differs from the last). */
  private cacheNow(state: OwnerState): void {
    if (!this.localState.mode || state.connection !== "live" || !state.summary || state.showingCached) return
    const json = JSON.stringify(state.summary)
    if (json === this.cachedJson) return
    this.cachedJson = json
    void saveNowCache(this.ports.prefs, state.summary, this.ports.now())
  }

  /** ReloVoice: a speaking mode starts the voice (downloading it on an unmetered connection) at once, sound only after 30 s. */
  private async startVoiceAtLaunch(): Promise<void> {
    const { voice } = this.ports
    await voice.ready().catch(() => undefined)
    if (!voice.button()) return
    if (voice.speaks()) {
      void voice.start()
      return
    }
    this.voiceTimer = setTimeout(() => {
      this.voiceTimer = null
      if (voice.button()) void voice.start()
    }, VOICE_SOUND_ONLY_DELAY_MS)
  }

  /**
   * Server address: the installer's hand-off wins, then what the owner chose before, then the dev default. An
   * installer that also handed a sign-in code (`relo auth join --windows-app`) signs this PC in with it, no UI.
   */
  private async chooseOrigin(): Promise<void> {
    const state = this.store.getState()
    if (state.connection !== "signedOut") return
    const launched = await this.ports.launchArgs().catch(() => null)
    const wanted = launched?.origin ?? state.serverOrigin ?? this.ports.defaultOrigin
    if (wanted && wanted !== state.serverOrigin) await this.store.setServerOrigin(wanted)
    if (launched?.signInCode && launched.codeVerifier) {
      this.ports.log("info", `sign-in with the installer's code for ${launched.origin}`)
      await this.crypto.ensureKeys().catch(() => undefined)
      await this.store.signInWithCode({ code: launched.signInCode, verifier: launched.codeVerifier, origin: launched.origin })
    }
  }

  stop(): void {
    this.store.stop()
    for (const off of this.offs.splice(0)) off()
    for (const timer of [this.heartbeat, this.pauseTimer, this.approvalTimer, this.snoozeTimer, this.updatedTimer, this.voiceTimer]) {
      if (timer) clearTimeout(timer)
    }
    if (this.heartbeat) clearInterval(this.heartbeat)
  }

  // --- sign-in ---------------------------------------------------------------------------------------------

  /** Sign in. `origin` is what the owner typed; omit it to use the remembered server. Again while signing in: the window comes back. */
  async signIn(origin?: string): Promise<void> {
    this.localProblem = null
    try {
      if (origin !== undefined && origin.trim() && !(await this.store.setServerOrigin(origin))) {
        this.localProblem = "That server address is not valid."
        return this.publish()
      }
      if (this.store.getState().connection === "signingIn") {
        const url = this.store.pendingSignInUrl({ device: "windows" })
        if (url) await this.present(url)
        return this.publish()
      }
      this.failure = null
      // The identity key exists before the server assigns this device its dev_ id; prekeys are signed for that id after.
      await this.crypto.ensureKeys()
      const url = await this.store.beginSignIn({ device: "windows" })
      if (url) await this.present(url)
    } catch (error) {
      this.store.cancelSignIn()
      this.fail("The sign-in window could not open.", error)
    }
    this.publish()
  }

  /**
   * Shows the sign-in page. A server that does not know `device=windows` yet answers 400 for the whole page: the page
   * is then asked for without it (the approval says iPhone until the server is deployed). If the window itself cannot
   * open, the system browser is the way through.
   */
  private async present(url: string): Promise<void> {
    let page = url
    if ((await this.ports.probe(url).catch(() => null)) === 400) {
      const plain = this.store.pendingSignInUrl()
      if (plain) {
        this.ports.log("warn", "the server does not know device=windows yet; signing in without it")
        page = plain
      }
    }
    try {
      await this.ports.openSignInWindow(page)
      this.inBrowser = false
    } catch (error) {
      this.ports.log("warn", `the sign-in window could not open (${describe(error)}); using the browser`)
      this.inBrowser = true
      await this.ports.openUrl(page)
    }
  }

  /** Cancel: closes the window and returns to where it was. */
  cancelSignIn(): void {
    this.store.cancelSignIn()
    this.localProblem = null
    this.inBrowser = false
    void this.ports.closeSignInWindow()
    this.publish()
  }

  /** The owner closed the sign-in window: that cancels sign-in (Mac wording). */
  private signInWindowClosed(): void {
    if (this.store.getState().connection !== "signingIn") return
    this.ports.log("info", "sign-in cancelled: the window was closed")
    this.store.cancelSignIn()
    this.publish()
  }

  /** Local mode: signs in to Relo on this PC with the code the relo command's join returned (no browser, no keys). */
  async signInLocally(origin: string, code: string, verifier: string): Promise<void> {
    this.localProblem = null
    if (this.store.getState().connection === "signingIn") this.store.cancelSignIn()
    await this.store.signInLocal(origin, code, verifier)
    this.publish()
  }

  private async completeSignIn(url: string): Promise<void> {
    const now = this.ports.now()
    if (this.lastCallback && this.lastCallback.url === url && now - this.lastCallback.at < DUPLICATE_MS) {
      this.ports.log("info", "sign-in callback ignored: already handled")
      return
    }
    this.lastCallback = { url, at: now }
    this.ports.log("info", "sign-in callback received")
    void this.ports.closeSignInWindow()
    try {
      await this.store.completeSignIn(url)
    } catch (error) {
      if (error instanceof OwnerClientError && error.kind === "state_mismatch") {
        // A stray or older link: the attempt that is open stays open.
        this.ports.log("warn", "sign-in callback ignored: it belongs to another attempt")
        this.lastCallback = null
        return
      }
      this.fail(
        error instanceof OwnerClientError && error.kind === "callback_malformed"
          ? "That sign-in link does not belong to an open sign-in. Sign in again."
          : "The sign-in did not complete. Try again.",
        error,
      )
    }
  }

  /** A failure the owner must see: logged, kept until the next attempt, and the notch opens by itself. */
  private fail(message: string, error?: unknown): void {
    this.ports.log("error", `${message}${error === undefined ? "" : ` (${describe(error)})`}`)
    this.localProblem = typeof error === "string" ? error : message
    this.failure = this.localProblem
    this.peek("failure")
    this.publish()
  }

  /** A missed question the owner has seen: the server drops it from Needs you (Mac `dismissMissed`), then Now is read again. */
  /** Resolves true when the server dropped it (or it was already gone); false when it could not, so the card can say "Already answered or expired". */
  dismissMissed = async (interactionId: string): Promise<boolean> => {
    try {
      return await this.store.dismissMissed(interactionId)
    } catch (error) {
      this.ports.log("warn", `dismiss: ${describe(error)}`)
      return false
    }
  }

  dismissFailure(): void {
    this.failure = null
    this.localProblem = null
    this.publish()
  }

  async signOut(): Promise<void> {
    this.ports.log("info", "sign out")
    this.clearApprovalTimer()
    void this.ports.closeSignInWindow()
    await this.crypto.forget()
    await this.store.signOut()
    // The Mac's signOut also drops the cached Now. Leaving Relo on this PC for a server also forgets the chosen address (it was
    // this PC's own loopback one); a plain sign-out keeps it, the seen notices and the last look, as the Mac does.
    const origin = this.store.getState().serverOrigin
    await clearNowCache(this.ports.prefs)
    this.cachedJson = null
    if (origin && isLoopback(origin)) await this.store.forgetServerOrigin()
    this.previous = null
    this.lastSummary = null
    this.updatedAt = null
    this.inBrowser = false
    this.waiting = []
    this.arrivals = []
    this.recentNotices = []
    this.failure = null
    this.localProblem = null
    this.encryptionProblem = null
    this.encryptionBusy = false
    this.publishEncryption()
    this.publish()
  }

  /** Another account: sign out, then sign in again (the server asks who). */
  async switchAccount(): Promise<void> {
    await this.signOut()
    await this.signIn()
  }

  /** The owner tapped an answer: `interactionId` is the pending question's id as the views know it. */
  answer: OnAnswer = (interactionId: string, action: AnswerAction, optionId?: string) => {
    const notificationId = notificationsByInteraction(this.store.getState().summary).get(interactionId)
    if (!notificationId) return
    void this.store.answer(notificationId, action, optionId ? { optionId } : {})
  }

  /** The notch opened or closed: Now is read relative to the last look. */
  viewChanged(open: boolean): void {
    this.notchOpen = open
    if (open) this.surfaceUpdated()
    void (open ? this.store.viewAppeared() : this.store.viewDisappeared())
  }

  private async onTrayAction(action: bridge.TrayAction): Promise<void> {
    switch (action) {
      case "sign_in":
        return this.signIn()
      case "sign_out":
        return this.signOut()
      case "update_install":
        return this.installUpdate()
      case "repair": // local mode: link again without asking anything
        await localRepair()
        return
      case "retry_start": // local mode: Relo's server would not start; start it again
        this.localProblem = null
        this.publish()
        this.localProblem = await this.ports.local.retry()
        this.publish()
        return
      case "open_dashboard": {
        // The Mac's `dashboardURL`: <origin>/dashboard on the server this PC is signed in to (or the chosen one).
        const url = this.store.dashboardUrl()
        if (url) await this.ports.openUrl(url).catch(() => undefined)
        return
      }
      case "check_updates":
        return this.checkForUpdates()
      case "pause_1h":
        return this.pause(this.ports.now() + HOUR_MS)
      case "resume":
        return this.pause(0)
      case "settings": // Rust opens the settings window
      case "quit": // Rust exits
      case "restart": // Rust restarts the app (tray.rs)
      case "open_notch": // Rust follows with `shortcut` openNotch, which the notch page handles
      case "open_home": // Rust opens the Home window
        return
    }
  }

  /** Relo's pause: sounds stay quiet for an hour. */
  private pause(until: number): void {
    this.pausedUntil = until
    quiet.pausedUntil = until
    if (this.pauseTimer) clearTimeout(this.pauseTimer)
    this.pauseTimer = until ? setTimeout(() => this.pause(0), Math.max(0, until - this.ports.now())) : null
    this.publish()
  }

  // --- computers waiting for approval (the Mac's waitingComputers) -----------------------------------------

  /** Reads the account's computers; hourly, or every two minutes while one waits (an approval elsewhere opens it here). */
  private async syncApprovals(): Promise<void> {
    this.clearApprovalTimer()
    if (this.store.getState().connection !== "live") return
    try {
      const before = this.waiting.map((computer) => computer.id).join()
      this.waiting = await this.crypto.syncApprovals()
      if (this.waiting.map((computer) => computer.id).join() !== before) {
        this.ports.log("info", `trust: waiting=${this.waiting.length}`)
        if (this.waiting.length > before.split(",").filter(Boolean).length) this.peek("approval")
        this.store.refreshNow() // computers approved elsewhere open their cards now
        this.publish()
      }
    } catch (error) {
      this.ports.log("warn", `approvals: ${describe(error)}`)
    }
    this.approvalTimer = setTimeout(() => void this.syncApprovals(), this.waiting.length ? WAITING_RECHECK_MS : HOUR_MS)
  }

  private clearApprovalTimer(): void {
    if (this.approvalTimer) clearTimeout(this.approvalTimer)
    this.approvalTimer = null
  }

  /** The owner approves a waiting computer here: its cards open here, and this PC's signed approval opens them on the other devices. */
  async approveComputer(id: string): Promise<void> {
    const computer = this.waiting.find((candidate) => candidate.id === id)
    if (!computer) return
    this.waiting = this.waiting.filter((candidate) => candidate.id !== id)
    this.publish()
    let done = false
    try {
      done = await this.crypto.approveComputer(id)
    } catch (error) {
      this.ports.log("error", `approve ${id}: ${describe(error)}`)
    }
    if (!done) {
      this.localProblem = `Relo could not approve ${computer.name} on this PC. Try again.`
      this.waiting = [...this.waiting, computer]
      this.publish()
      return
    }
    this.store.refreshNow()
  }

  /** Declined here: the computer stays listed and its cards stay closed on this PC. */
  async declineComputer(id: string): Promise<void> {
    this.waiting = this.waiting.filter((candidate) => candidate.id !== id)
    this.publish()
    await this.crypto.declineComputer(id).catch((error) => this.ports.log("error", `decline ${id}: ${describe(error)}`))
  }

  // --- updates (the Mac's ReloUpdater / UpdatePolicy) ------------------------------------------------------

  /** Tells Rust where to look and whether to install by itself; again whenever the server or the setting changes. */
  private configureUpdates(): void {
    const feed = updateFeedUrl(this.store.getState().serverOrigin, this.ports.releaseOrigin, false)
    const auto = this.ports.autoInstall.get()
    if (feed === this.configuredFeed && auto === this.configuredAuto) return
    this.configuredFeed = feed
    this.configuredAuto = auto
    void this.ports.updater.configure(feed, auto).catch((error) => this.ports.log("warn", `updates: ${describe(error)}`))
  }

  private onUpdateState(state: native.UpdateState): void {
    if (state.state === "error") this.ports.log("warn", `updates: ${state.message ?? "failed"}`)
    const next = state.state === "available" || state.state === "ready" ? { version: state.version ?? "", ready: state.state === "ready" } : null
    if (state.state === "none" || state.state === "error") this.updateState = null
    else if (next && next.version) {
      const first = !this.updateState || this.updateState.version !== next.version
      this.updateState = next
      if (first && this.visibleUpdate()) this.peek("update")
    }
    this.publish()
  }

  private visibleUpdate(): { version: string; ready: boolean } | null {
    const update = this.updateState
    return update && !isSnoozed(update.version, this.snooze, this.ports.now()) ? update : null
  }

  /** The stored "Later" (the Mac's relo.update.snoozedVersion / snoozedUntil), and the moment the reminder comes back. */
  private async loadSnooze(): Promise<void> {
    try {
      this.snooze = parseSnooze(await this.ports.prefs.get(SNOOZE_PREF))
    } catch {
      this.snooze = null
    }
    this.armSnoozeTimer()
  }

  private armSnoozeTimer(): void {
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer)
    this.snoozeTimer = null
    const snooze = this.snooze
    if (!snooze) return
    const left = snooze.until - this.ports.now()
    if (left <= 0) return
    // The reminder returns by itself, one second after the snooze ends (UpdatePolicy.snoozeInterval + 1).
    this.snoozeTimer = setTimeout(() => {
      this.snoozeTimer = null
      this.publish()
    }, left + 1000)
  }

  /** "Later": hides the reminder in the notch until tomorrow; it comes back by itself. The tray keeps showing the update. */
  later(): void {
    const update = this.updateState
    if (!update) return
    this.snooze = { version: update.version, until: snoozedUntil(this.ports.now()) }
    void this.ports.prefs.set(SNOOZE_PREF, JSON.stringify(this.snooze)).catch(() => undefined)
    this.armSnoozeTimer()
    this.publish()
  }

  /** Restart now (or Update, when it is not downloaded yet). */
  async installUpdate(): Promise<void> {
    try {
      await this.ports.updater.install()
    } catch (error) {
      this.fail("The update could not be installed. Try again.", error)
    }
  }

  /**
   * The owner's own check (the tray's "Check for Updates…"; the Mac shows Sparkle's window): an update found shows through the
   * usual reminder, and the answer to a check that found nothing is a short toast.
   */
  checkForUpdates(): void {
    void this.ports.updater
      .checkManual()
      .then(async (result) => {
        if (!result) return
        if (result.state === "none") await this.ports.showToast("Relo", "Relo is up to date.")
        else if (result.state === "error") await this.ports.showToast("Relo", "Relo could not check for updates.")
      })
      .catch(() => undefined)
  }

  /** The first launch of a new version outside local mode: "Updated to X" (local mode reports it with `local_updated`). */
  private async announceUpdated(): Promise<void> {
    const after = await this.ports.updater.afterUpdate().catch(() => null)
    if (!after) return
    this.queueUpdated(updatedLine(after.version, after.agents))
  }

  /**
   * "Updated to …" shows for ten seconds from the first time the notch opens (the Mac's `surfaceNotice`), not from launch; one
   * already showing is replaced in place, and one that arrives while the notch is open shows at once.
   */
  private queueUpdated(text: string): void {
    this.pendingUpdated = text
    if (this.updated !== null || this.notchOpen) this.surfaceUpdated()
  }

  private surfaceUpdated(): void {
    const text = this.pendingUpdated
    if (text === null) return
    this.pendingUpdated = null
    this.updated = text
    if (this.updatedTimer) clearTimeout(this.updatedTimer)
    this.updatedTimer = setTimeout(() => {
      this.updated = null
      this.updatedTimer = null
      this.publish()
    }, UPDATED_LINE_MS)
    this.publish()
  }

  // --- state -----------------------------------------------------------------------------------------------

  private peek(kind: PeekKind): void {
    this.peekState = { serial: (this.peekState?.serial ?? 0) + 1, kind }
  }

  private onState(state: OwnerState): void {
    if (state.summary !== this.lastSummary) {
      this.lastSummary = state.summary
      if (state.summary) {
        // A cached Now was read a while ago: "Live · <time>" waits for the server's own answer.
        if (!state.showingCached) this.updatedAt = this.ports.now()
        this.logNow(state.summary)
        const next = presentationOf(state.summary)
        const events = eventsBetween(this.previous, next)
        this.previous = next
        if (events.length) this.ports.playFor(events.map((event) => ({ kind: event.kind, tone: event.row.tone })))
      } else {
        this.previous = null
      }
    }
    this.cacheNow(state)
    this.onConnection(state)
    this.onNotices(state)
    this.configureUpdates()
    this.publish()
    this.publishEncryption()
  }

  /** The Mac's `now:` line (ReloNotchStore.receive): counts only, never titles or text, which may be private. */
  private logNow(summary: NowSummary): void {
    this.ports.log(
      "info",
      `now: needsYou=${summary.needsYou.length} running=${summary.running.length} recent=${summary.recent.length} yourTurn=${summary.waitingOnYou.length} quiet=${summary.quiet.length} sessions=${summary.sessions.sessions.length} focus=${summary.lockScreen.focus != null}`,
    )
  }

  private onConnection(state: OwnerState): void {
    const was = this.lastConnection
    const now = state.connection
    if (was === now) return
    this.lastConnection = now
    if (now === "live") {
      this.failure = null
      this.localProblem = null
      void this.syncApprovals()
    }
    if (now !== "live" && now !== "connecting") {
      this.waiting = []
      this.clearApprovalTimer()
    }
    const ended = now === "signedOut" || now === "needsSignIn"
    if (ended && (was === "signingIn" || was === "connecting") && state.problem) {
      this.ports.log("error", `sign-in ended: ${state.problem}`)
      this.failure = state.problem
      this.peek("failure")
    } else if (now === "needsSignIn") {
      this.ports.log("warn", "the server signed this PC out")
      this.peek("signedOut")
    }
  }

  /**
   * Notices (`relo notify`) when no phone of the account gets the push: a peek, once each (owner-client keeps the rules), and a
   * toast only when the notch cannot be seen (a full-screen app is in front). The Mac has no notification center: a notice there
   * is the notch's moment and the Recent list, so a toast beside the open notch would say it twice.
   */
  private onNotices(state: OwnerState): void {
    const arrival = state.noticeArrivals
    if (arrival.serial === this.noticeSerial) return
    this.noticeSerial = arrival.serial
    if (!arrival.notices.length) return
    this.arrivals = arrival.notices
    this.recentNotices = [...arrival.notices, ...this.recentNotices.filter((n) => !arrival.notices.some((a) => a.id === n.id))].slice(0, 12)
    this.peek("notice")
    if (!this.ports.notchHidden()) return
    for (const notice of arrival.notices) {
      void this.ports.showToast(notice.title, notice.summary ?? notice.source).catch((error) => this.ports.log("warn", `toast: ${describe(error)}`))
    }
  }

  // --- Settings' Encryption group (the Mac's ReloEncryptionGroup / store.refreshEncryption / setEncryption) -------

  private async onEncryptionRequest(request: native.EncryptionRequest): Promise<void> {
    switch (request.action) {
      case "refresh":
        if (this.localState.mode) return this.publishEncryption(true)
        await this.store.refreshEncryption()
        return this.publishEncryption(true)
      case "set":
        if (this.encryptionBusy) return
        this.encryptionBusy = true
        this.encryptionProblem = null
        this.publishEncryption(true)
        this.encryptionProblem = await this.store.setEncryption(request.always)
        this.encryptionBusy = false
        return this.publishEncryption(true)
      case "open_security": {
        const url = this.store.securityUrl()
        if (url) await this.ports.openUrl(url).catch(() => undefined)
        return
      }
    }
  }

  private lastEncryption = ""

  /** Tells the Settings window where the policy stands; only when it changed, unless Settings just asked. */
  private publishEncryption(force = false): void {
    const state = this.store.getState()
    const report: native.EncryptionReport = {
      mode: this.localState.mode ? null : (state.encryption?.mode ?? null),
      phoneTrusted: state.phoneTrusted,
      problem: this.encryptionProblem,
      busy: this.encryptionBusy,
    }
    const key = JSON.stringify(report)
    if (!force && key === this.lastEncryption) return
    this.lastEncryption = key
    this.ports.reportEncryption(report)
  }

  private compute(state: OwnerState): OwnerView {
    const local = this.localState
    return {
      connection: state.connection,
      summary: state.summary,
      spoken: this.crypto.spokenWords(),
      questions: questionSpecs(state),
      answers: answerPhases(state),
      offline: state.connection === "offline",
      problem: this.localProblem ?? state.problem,
      approval: approvalOf(state),
      serverOrigin: state.serverOrigin,
      accountEmail: state.accountEmail,
      pausedUntil: this.pausedUntil,
      failure: this.failure,
      waitingComputers: this.waiting,
      update: this.visibleUpdate(),
      updatedLine: this.updated,
      arrivals: this.arrivals,
      peek: this.peekState,
      signInInBrowser: this.inBrowser && state.connection === "signingIn",
      updatedAt: this.updatedAt,
      notices: this.recentNotices,
      cached: state.showingCached,
      localStarting: local.mode && local.phase === "starting" && state.summary === null,
      localStartFailed: local.mode && local.phase === "failed",
      local: local.mode,
    }
  }

  private publish(): void {
    const state = this.store.getState()
    this.view = this.compute(state)
    // The tray shows a waiting update whether or not the owner chose Later in the notch (the Mac's menu reads `waiting`).
    const update = this.updateState
    const tray: bridge.TrayState = {
      ...trayStateOf(state, this.pausedUntil > this.ports.now()),
      needsSignIn: state.connection === "needsSignIn",
      signingIn: state.connection === "signingIn",
      updateVersion: update?.version ?? null,
      updateReady: update?.ready ?? false,
    }
    if (this.localState.mode) {
      tray.local = true
      if (this.view.localStartFailed) tray.localFailed = true
      if (this.view.localStarting) {
        tray.status = "starting"
        tray.connecting = false
      }
    }
    void this.ports.setTray(tray).catch(() => undefined)
    for (const listener of this.listeners) listener()
  }
}

/** A line for the log: the kind of error and its status, never a message that could carry a secret. */
export function describe(error: unknown): string {
  if (error instanceof OwnerClientError) return `${error.kind}${error.status ? ` ${error.status}` : ""}${error.code ? ` ${error.code}` : ""}`
  if (typeof error === "string") return error.slice(0, 200)
  if (error instanceof Error) return error.name
  return "unknown"
}

/** Filled in by `run()` once the app version is known; the store reads it when it registers. */
const placeholderDevice: DeviceInfo = {
  name: "Windows PC",
  bundleIdentifier: "ai.relo.windows",
  appVersion: "0.1.0",
  appBuild: "1",
  osVersion: "Windows",
}

async function deviceInfo(): Promise<DeviceInfo> {
  let version = "0.1.0"
  if (bridge.inTauri) {
    try {
      version = await (await import("@tauri-apps/api/app")).getVersion()
    } catch {
      // keep the default
    }
  }
  let os = "Windows"
  try {
    const hints = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(keys: string[]): Promise<{ platformVersion?: string }> } }).userAgentData
    const platformVersion = (await hints?.getHighEntropyValues(["platformVersion"]))?.platformVersion
    // Windows 11 reports platform version 13 and up; Windows 10 reports 1 to 10.
    if (platformVersion) os = Number.parseInt(platformVersion, 10) >= 13 ? "Windows 11" : "Windows 10"
  } catch {
    // keep the default
  }
  return { name: "Windows PC", bundleIdentifier: "ai.relo.windows", appVersion: version, appBuild: version, osVersion: os }
}

/** GET the sign-in page without following redirects: 400 means the server refused the request (an older server and `device=windows`). */
async function probePage(url: string): Promise<number | null> {
  try {
    return (await appFetch(url, { method: "GET", redirect: "manual", cache: "no-store" })).status
  } catch {
    return null
  }
}

export function createOwnerApp(): OwnerApp {
  void settingsStore.start()
  return new OwnerApp({
    fetch: appFetch,
    secrets: createSecretStore(),
    prefs: createPrefsStore(),
    keys: indexedDbStore(),
    device: deviceInfo,
    openUrl: bridge.openUrl,
    setTray: bridge.setTray,
    onTrayAction: bridge.onTrayAction,
    onAuthCallback: bridge.onAuthCallback,
    onFullscreen: bridge.onFullscreen,
    fullscreenGet: bridge.fullscreenGet,
    launchArgs: bridge.launchArgs,
    // Sounds and voice for new moments are src/alerts' (useAlerts), which sees the sealed spoken words and every rule; not here.
    playFor: () => {},
    preloadSounds: () => cuePlayer.preload(),
    defaultOrigin: (import.meta.env.VITE_RELO_ORIGIN as string | undefined) || null,
    now: Date.now,
    openSignInWindow: native.openSignInWindow,
    closeSignInWindow: native.closeSignInWindow,
    onSignInClosed: native.onSignInClosed,
    onSignInRequest: native.onSignInRequest,
    onSignOutRequest: native.onSignOutRequest,
    cli: { onInviteRequest: native.onInviteRequest, reportInvite: native.reportInvite },
    probe: probePage,
    showToast: native.showToast,
    log: native.logEvent,
    autoInstall: { get: () => settingsStore.get().autoInstallUpdates, onChange: (cb) => settingsStore.onChange(cb) },
    updater: {
      configure: native.updaterConfigure,
      install: native.updaterInstall,
      checkNow: native.updaterCheckNow,
      checkManual: native.updaterCheckManual,
      onState: native.onUpdateState,
      afterUpdate: native.updaterAfterUpdate,
    },
    local: { get: localStateGet, onState: onLocalState, onUpdated: onLocalUpdated, retry: localRetryStart },
    voice: {
      ready: () => settingsStore.start(),
      button: () => settingsStore.get().voiceButton,
      speaks: () => settingsStore.get().voiceMode !== "soundOnly",
      start: startVoiceEngine,
    },
    notchHidden: () => quiet.fullscreen,
    onEncryptionRequest: native.onEncryptionRequest,
    reportEncryption: native.reportEncryption,
    releaseOrigin: RELEASE_ORIGIN,
  })
}
