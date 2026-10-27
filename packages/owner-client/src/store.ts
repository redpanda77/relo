import type { NowSummary } from "@relo/notification-contracts";
import { dismissMissedQuestion, fetchQuestion, submitAnswer, type AnswerAction, type Question } from "./answers.js";
import { createComputerInvite, deviceStanding, heartbeat, registerDevice, revokeDevice, signOutAccount } from "./device.js";
import { OwnerClientError, isUnauthorized } from "./errors.js";
import { abortableSleep, followEvents } from "./events.js";
import { normalizeOrigin, OwnerHttp } from "./http.js";
import { KeySchedule, publishKeys } from "./keys.js";
import { fetchCurrentPage, fetchNow, nextWaitSeconds } from "./now.js";
import { freshNotices, noticesFrom, SeenNotices, showsNotices, type OwnerNotice } from "./notices.js";
import { createPkce, type Pkce } from "./pkce.js";
import { readEncryptionPolicy, writeEncryptionPolicy, type EncryptionPolicy } from "./policy.js";
import { buildAuthorizationUrl, exchangeCode, parseCallback, type SignInDevice } from "./signIn.js";
import { memoryStore, OWNER_CAPABILITIES, type DeviceInfo, type FetchLike, type OwnerCrypto, type PrefsStore, type SecretStore } from "./types.js";

export type Connection = "starting" | "signedOut" | "signingIn" | "connecting" | "live" | "offline" | "needsSignIn";
export type AnswerPhase = { phase: "sending" } | { phase: "accepted" } | { phase: "failed"; message: string };

export interface OwnerState {
  connection: Connection;
  /** The server's derivation of Now, displayed as is. */
  summary: NowSummary | null;
  lastUpdated: number | null;
  problem: string | null;
  accountEmail: string | null;
  serverOrigin: string | null;
  notices: OwnerNotice[];
  /** `serial` changes with every batch of notices that just arrived. */
  noticeArrivals: { serial: number; notices: OwnerNotice[] };
  phoneReceivesPushes: boolean | null;
  /** Whether a trusted device approved this device (null = unknown). */
  deviceTrusted: boolean | null;
  questions: Record<string, Question>;
  answers: Record<string, AnswerPhase>;
  /** The remote server's encryption choice (Settings), once read; null before, signed out and in local mode. */
  encryption: EncryptionPolicy | null;
  /** Whether another device of the account is a trusted iPhone (the note under "Always"). */
  phoneTrusted: boolean;
  /** The Now on screen is the last one this PC read (a moment ago), until the server answers (local mode's launch cache). */
  showingCached: boolean;
}

export interface OwnerStoreDeps {
  fetch: FetchLike;
  /** Credentials: the account session and the device credential. */
  secrets: SecretStore;
  /** Non-secret, possibly long: the chosen server, seen notices, the last look. Defaults to memory. */
  prefs?: PrefsStore;
  crypto: OwnerCrypto;
  device: DeviceInfo;
  now?: () => number;
  randomUuid?: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Where failures go to be logged (the host decides: console, a file). */
  log?: (message: string, error?: unknown) => void;
  /** A line about what happened (counts and states, never text): "notices: current=2 new=1", "registered again with ...". */
  note?: (message: string) => void;
}

interface Identity { stableDeviceId: string; installationId: string }
interface StoredSession { token: string; sessionId: string; expiresAt: string; origin: string; email: string }
interface StoredDevice {
  deviceId: string; accountId: string; accessToken: string; installationId: string;
  origin: string; email: string; capabilities: string[];
  /** Registered by local mode: nothing is sealed for it, so no key is published. */
  local?: true;
}

/** `http://127.0.0.1:<port>` or `http://localhost:<port>`: where local mode's server listens. */
function isLoopbackHttp(origin: string): boolean {
  try { const url = new URL(origin); return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"); } catch { return false; }
}

const KEY = { identity: "relo.owner.identity", session: "relo.owner.session", device: "relo.owner.device", attempt: "relo.owner.signin" };
const ATTEMPT_MAX_MS = 24 * 3_600_000;
interface Attempt { pkce: Pkce; origin: string; previous: Connection }
interface StoredAttempt { verifier: string; challenge: string; state: string; origin: string; previous: Connection; at: number }
const PREF = { origin: "relo.owner.origin", seen: "relo.owner.seenNotices", looked: "relo.owner.lookedAt" };
/** Hint bursts become one read after this long. */
const WAKE_MS = 750;
const PHONE_CHECK_MS = 120_000;
/** Relo on this PC (apps/windows/src/local/words.ts): nothing to sign in to, so a lost link is a repair. */
const LOCAL_WORDS = { needsRepair: "Relo needs a quick repair on this PC.", notAnswering: "Relo isn't answering on this PC." };

const initial = (): OwnerState => ({
  connection: "starting", summary: null, lastUpdated: null, problem: null, accountEmail: null, serverOrigin: null,
  notices: [], noticeArrivals: { serial: 0, notices: [] }, phoneReceivesPushes: null, deviceTrusted: null, questions: {}, answers: {},
  encryption: null, phoneTrusted: false, showingCached: false,
});

async function readJson<T>(store: { get(k: string): Promise<string | null> }, key: string): Promise<T | null> {
  try { const text = await store.get(key); return text ? JSON.parse(text) as T : null; } catch { return null; }
}

/**
 * This device as an owner-overview device: signed in, Now kept live, questions answered. Like the apps it displays
 * the server's derivation and holds no policy: the only clocks here are the transport's (reconnect, the 60 s tick,
 * the server's own `refreshAt`).
 */
export class OwnerStore {
  private state: OwnerState = initial();
  private readonly listeners = new Set<(state: OwnerState) => void>();
  private readonly prefs: PrefsStore;
  private readonly now: () => number;
  private readonly keys: KeySchedule;
  private device: StoredDevice | null = null;
  private identity: Identity | null = null;
  private pending: Attempt | null = null;
  private feed: AbortController | null = null;
  private wake: ReturnType<typeof setTimeout> | null = null;
  private fetching = false;
  private refetchAfter = false;
  private etag: string | null = null;
  private seen = new SeenNotices();
  private phoneCheckedAt: number | null = null;
  private since: string | null = null;
  private visibleSince: number | null = null;

  constructor(private readonly deps: OwnerStoreDeps) {
    this.prefs = deps.prefs ?? memoryStore();
    this.now = deps.now ?? Date.now;
    this.keys = new KeySchedule(this.now);
  }

  getState(): OwnerState { return this.state; }

  subscribe(listener: (state: OwnerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<OwnerState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private http(origin: string): OwnerHttp { return new OwnerHttp(origin, this.deps.fetch); }

  // --- lifecycle ---------------------------------------------------------------------------------------------

  /** Restores the stored credential and starts the live feed; signedOut when there is none. */
  async start(): Promise<void> {
    this.seen = new SeenNotices(await readJson<string[]>(this.prefs, PREF.seen) ?? []);
    this.identity = await readJson<Identity>(this.deps.secrets, KEY.identity);
    const device = await readJson<StoredDevice>(this.deps.secrets, KEY.device);
    const chosen = await this.prefs.get(PREF.origin);
    if (!device) {
      this.set({ connection: "signedOut", serverOrigin: chosen });
      return;
    }
    this.device = device;
    this.set({ connection: "connecting", serverOrigin: device.origin, accountEmail: device.email });
    this.startFeed();
    void this.refreshRegistrationIfNeeded();
  }

  stop(): void { this.stopFeed(); }

  /** The server address the owner typed; null when it is not an address. */
  async setServerOrigin(text: string): Promise<boolean> {
    const origin = normalizeOrigin(text);
    if (!origin) return false;
    await this.prefs.set(PREF.origin, origin);
    this.set({ serverOrigin: origin });
    return true;
  }

  /** Forgets the chosen server (Mac `forgetServerOrigin`): the owner leaves a server, or Relo on this PC, for another. */
  async forgetServerOrigin(): Promise<void> {
    await this.prefs.delete(PREF.origin);
    if (!this.device) this.set({ serverOrigin: null });
  }

  /**
   * Draws a Now read a moment ago (local mode's launch cache; its cards are never sealed) until the server answers.
   * Only while this device is connecting and has nothing newer.
   */
  seedCached(summary: NowSummary): boolean {
    if (this.state.summary || this.state.connection !== "connecting" || !this.device) return false;
    this.set({ summary, showingCached: true });
    return true;
  }

  // --- sign-in -----------------------------------------------------------------------------------------------

  /** Starts a browser sign-in: returns the page to open. The host opens it and passes the `relo://auth/callback` URL to `completeSignIn`. */
  async beginSignIn(options: { signUp?: boolean; device?: SignInDevice } = {}): Promise<string | null> {
    if (this.state.connection === "signingIn") return null;
    const origin = this.state.serverOrigin;
    if (!origin) { this.set({ problem: "Enter your Relo server's address first." }); return null; }
    const pkce = await createPkce();
    this.pending = { pkce, origin, previous: this.state.connection === "starting" ? "signedOut" : this.state.connection };
    // The attempt outlives the page: a reload or restart between "approve" and the callback must not lose it.
    await this.saveAttempt(this.pending, this.now());
    this.set({ connection: "signingIn", problem: null });
    return buildAuthorizationUrl(origin, pkce, options);
  }

  /** The same page again (same PKCE state) for the attempt in progress, e.g. to reopen the sign-in window. */
  pendingSignInUrl(options: { signUp?: boolean; device?: SignInDevice } = {}): string | null {
    return this.pending ? buildAuthorizationUrl(this.pending.origin, this.pending.pkce, options) : null;
  }

  cancelSignIn(): void {
    const pending = this.pending;
    this.pending = null;
    void this.deps.secrets.delete(KEY.attempt).catch(() => undefined);
    if (!pending) return;
    this.set({ connection: pending.previous });
  }

  private async saveAttempt(pending: Attempt, at: number): Promise<void> {
    const stored: StoredAttempt = { verifier: pending.pkce.verifier, challenge: pending.pkce.challenge, state: pending.pkce.state, origin: pending.origin, previous: pending.previous, at };
    try { await this.deps.secrets.set(KEY.attempt, JSON.stringify(stored)); } catch (error) { this.deps.log?.("sign-in attempt not persisted", error); }
  }

  /** The attempt in progress, from memory or, after a reload, from storage (a day-old one is dropped). */
  private async currentAttempt(): Promise<Attempt | null> {
    if (this.pending) return this.pending;
    const stored = await readJson<StoredAttempt>(this.deps.secrets, KEY.attempt);
    if (!stored || typeof stored.verifier !== "string" || this.now() - stored.at > ATTEMPT_MAX_MS) return null;
    this.pending = { pkce: { verifier: stored.verifier, challenge: stored.challenge, state: stored.state }, origin: stored.origin, previous: stored.previous };
    return this.pending;
  }

  /** A one-time code handed over without a browser (the installer's `--relo-sign-in-code`): sign in with it. */
  async signInWithCode(input: { code: string; verifier: string; origin: string }): Promise<void> {
    this.set({ connection: "signingIn", problem: null });
    await this.finishSignIn(input.origin, input.code, input.verifier, this.device ? "needsSignIn" : "signedOut");
  }

  /**
   * The callback URL the browser ended at. A wrong state is rejected and the attempt stays open (a stray link must
   * not end a real sign-in); any other outcome ends it.
   */
  async completeSignIn(callbackUrl: string): Promise<void> {
    const pending = await this.currentAttempt();
    if (!pending) throw new OwnerClientError("callback_malformed");
    const outcome = parseCallback(callbackUrl, pending.pkce.state);
    this.pending = null;
    await this.deps.secrets.delete(KEY.attempt).catch(() => undefined);
    if (outcome.type === "cancelled") { this.set({ connection: pending.previous }); return; }
    await this.finishSignIn(pending.origin, outcome.code, pending.pkce.verifier, this.device ? "needsSignIn" : "signedOut");
  }

  /**
   * Local mode ("Run Relo on this PC"): signs in to the server on this PC with the one-time code the relo command's
   * join handed over, and the PKCE verifier this app made for it (no browser). Nothing leaves the PC, so nothing is
   * sealed and no key is published. Only a loopback `http` origin is accepted.
   */
  async signInLocal(origin: string, code: string, verifier: string): Promise<void> {
    const normalized = normalizeOrigin(origin);
    if (!normalized || !isLoopbackHttp(normalized)) { this.set({ problem: "That is not a server address." }); return; }
    if (!/^relo_signin_[A-Za-z0-9_-]{43}$/.test(code)) { this.set({ problem: "The sign-in did not complete. Try again." }); return; }
    this.pending = null;
    this.set({ connection: "signingIn", problem: null, serverOrigin: normalized });
    await this.finishSignIn(normalized, code, verifier, "signedOut", true);
  }

  private async finishSignIn(origin: string, code: string, verifier: string, onFailure: Connection, local = false): Promise<void> {
    try {
      const ids = await this.ids();
      const http = this.http(origin);
      const session = await exchangeCode(http, { code, verifier, installationId: ids.installationId });
      await this.deps.secrets.set(KEY.session, JSON.stringify({
        token: session.sessionToken, sessionId: session.session.id, expiresAt: session.session.expiresAt,
        origin, email: session.user.email,
      } satisfies StoredSession));
      await this.register(origin, session.sessionToken, session.session.id, local);
      this.startFeed();
    } catch (error) {
      this.deps.log?.("sign-in failed", error);
      this.set({ problem: this.message(error), connection: onFailure });
    }
  }

  private async ids(): Promise<Identity> {
    if (this.identity) return this.identity;
    const uuid = this.deps.randomUuid ?? (() => globalThis.crypto.randomUUID());
    this.identity = { stableDeviceId: uuid(), installationId: uuid() };
    await this.deps.secrets.set(KEY.identity, JSON.stringify(this.identity));
    return this.identity;
  }

  private async register(origin: string, sessionToken: string, sessionId: string, local = this.device?.local === true): Promise<void> {
    this.set({ connection: "connecting" });
    const ids = await this.ids();
    const registration = await registerDevice(this.http(origin), { sessionToken, sessionId, ids, info: this.deps.device });
    this.device = {
      deviceId: registration.device.deviceId, accountId: registration.account.accountId,
      accessToken: registration.credential.accessToken, installationId: registration.device.installationId,
      origin, email: registration.account.email, capabilities: [...OWNER_CAPABILITIES], ...(local ? { local: true } : {}),
    };
    await this.deps.secrets.set(KEY.device, JSON.stringify(this.device));
    await this.prefs.set(PREF.origin, origin);
    this.keys.reset();
    this.set({ serverOrigin: origin, accountEmail: registration.account.email, problem: null });
  }

  /** A build that declares other capabilities registers again once, with the stored account session. */
  private async refreshRegistrationIfNeeded(): Promise<void> {
    const device = this.device;
    if (!device || [...device.capabilities].sort().join() === [...OWNER_CAPABILITIES].sort().join()) return;
    const session = await readJson<StoredSession>(this.deps.secrets, KEY.session);
    if (!session || session.origin !== device.origin) return;
    try {
      await this.register(device.origin, session.token, session.sessionId);
      this.deps.note?.(`registered again with ${OWNER_CAPABILITIES.join(",")}`);
      this.startFeed();
    } catch (error) {
      this.deps.log?.("registering again failed", error);
      if (!isUnauthorized(error)) this.set({ problem: this.message(error) });
    }
  }

  async signOut(): Promise<void> {
    this.stopFeed();
    const device = this.device;
    const session = await readJson<StoredSession>(this.deps.secrets, KEY.session);
    if (device) await revokeDevice(this.http(device.origin), device).catch(() => undefined);
    if (device && session) await signOutAccount(this.http(device.origin), session.token).catch(() => undefined);
    await this.deps.secrets.delete(KEY.device);
    await this.deps.secrets.delete(KEY.session);
    this.device = null;
    this.etag = null;
    this.since = null;
    this.keys.reset();
    this.phoneCheckedAt = null;
    this.set({ ...initial(), connection: "signedOut", serverOrigin: this.state.serverOrigin });
  }

  /**
   * A one-time code for this computer's `relo` command to join the account this device is signed in to (the Windows app's
   * onboarding hands it straight to `relo auth join`). Only for the server the caller expects: a device signed in to
   * another one is "unauthorized", so a code never goes to the wrong account.
   */
  async createComputerInvite(origin: string): Promise<string> {
    const device = this.device;
    if (!device || device.origin !== origin || device.local) throw new OwnerClientError("unauthorized");
    return (await createComputerInvite(this.http(device.origin), device)).code;
  }

  /** PUT /api/devices/:id: tells the server this install is alive and what version it is. */
  async sendHeartbeat(): Promise<void> {
    if (this.device) await heartbeat(this.http(this.device.origin), this.device, this.deps.device);
  }

  // --- the live feed -----------------------------------------------------------------------------------------

  private startFeed(): void {
    this.stopFeed();
    const device = this.device;
    if (!device) { this.set({ connection: "signedOut" }); return; }
    const controller = new AbortController();
    this.feed = controller;
    if (this.state.connection !== "live") this.set({ connection: "connecting" });
    const http = this.http(device.origin);
    const sleep = this.deps.sleep ?? abortableSleep;
    void followEvents({
      http, token: device.accessToken, signal: controller.signal, onHint: () => this.wakeUp(),
      sleep, ...(this.deps.random ? { random: this.deps.random } : {}),
    }).catch((error) => { if (isUnauthorized(error)) this.credentialRefused(); else if (!controller.signal.aborted) this.set({ problem: this.message(error) }); });
    void (async () => {
      while (!controller.signal.aborted) {
        await this.fetch();
        await this.maintainKeys();
        await sleep(nextWaitSeconds(this.state.summary) * 1000, controller.signal);
      }
    })();
  }

  private stopFeed(): void {
    this.feed?.abort();
    this.feed = null;
    if (this.wake) clearTimeout(this.wake);
    this.wake = null;
  }

  private wakeUp(): void {
    if (this.wake) return;
    this.wake = setTimeout(() => { this.wake = null; void this.fetch(); }, WAKE_MS);
  }

  /** The device woke or the network came back: read Now again right away. */
  refreshNow(): void { if (this.device) void this.fetch(); }

  private credentialRefused(): void {
    this.stopFeed();
    this.set({ connection: "needsSignIn", problem: this.device?.local ? LOCAL_WORDS.needsRepair : "The server signed this PC out. Sign in again." });
  }

  private async fetch(): Promise<void> {
    if (this.fetching) { this.refetchAfter = true; return; }
    this.fetching = true;
    try {
      do {
        this.refetchAfter = false;
        await this.fetchOnce();
      } while (this.refetchAfter && this.feed && !this.feed.signal.aborted);
    } finally { this.fetching = false; }
  }

  private async fetchOnce(): Promise<void> {
    const device = this.device;
    if (!device) return;
    const http = this.http(device.origin);
    try {
      const result = await fetchNow(http, device.accessToken, this.deps.crypto, {
        ...(this.since ? { since: this.since } : {}), ...(this.etag ? { etag: this.etag } : {}),
      });
      if (this.device !== device || !this.feed || this.feed.signal.aborted) return;
      if (!result.unchanged) {
        this.etag = result.etag;
        this.set({ summary: result.summary, lastUpdated: this.now(), showingCached: false });
        this.loadQuestions(result.summary);
      }
      this.set({ connection: "live", problem: null, showingCached: false });
      await this.readNotices(http, device, result.unchanged ? this.state.summary : result.summary);
    } catch (error) {
      if (this.device !== device) return;
      if (isUnauthorized(error)) {
        this.deps.note?.("now: refused (sign in again)");
        this.credentialRefused();
      } else {
        this.deps.log?.("now: fetch failed", error);
        this.set({ connection: "offline" });
      }
    }
  }

  private async maintainKeys(): Promise<void> {
    const device = this.device;
    if (device?.local) return; // local mode: nothing leaves this PC, nothing is sealed
    const due = this.keys.due();
    if (!device || !due.due) return;
    this.keys.attempted();
    try {
      await publishKeys(this.http(device.origin), device, this.deps.crypto, due.rotate);
      this.keys.succeeded();
    } catch (error) {
      if (due.rotate) this.keys.failedRotation();
      this.deps.log?.("keys: publishing failed", error);
      if (isUnauthorized(error)) this.credentialRefused();
      else this.set({ problem: "This PC's encryption keys were not published yet; Relo will retry." });
    }
  }

  // --- encryption (a remote server only) ---------------------------------------------------------------------

  /** Reads the server's encryption choice and whether an iPhone is trusted (Settings, remote only). A failed read changes nothing. */
  async refreshEncryption(): Promise<void> {
    const device = this.device;
    if (!device || device.local) return;
    const http = this.http(device.origin);
    try {
      const policy = await readEncryptionPolicy(http, device.accessToken);
      if (this.device !== device) return;
      this.set({ encryption: policy });
      const standing = await deviceStanding(http, device.accessToken).catch((error) => { if (isUnauthorized(error)) throw error; return null; });
      if (standing && this.device === device) this.set({ phoneTrusted: standing.phone });
    } catch (error) {
      if (isUnauthorized(error)) this.credentialRefused();
    }
  }

  /** Picks Always (`true`) or Automatic (`false`); the words of what went wrong, or null. Off is the Dashboard's. */
  async setEncryption(always: boolean): Promise<string | null> {
    const device = this.device;
    if (!device || device.local) return "Sign in first.";
    try {
      const policy = await writeEncryptionPolicy(this.http(device.origin), device.accessToken, always);
      if (this.device === device) this.set({ encryption: policy });
      return null;
    } catch (error) {
      if (isUnauthorized(error)) this.credentialRefused();
      return "Relo could not change that. Try again.";
    }
  }

  /** The Dashboard on the owner's server, for what the notch cannot do (text replies, history); null without a server. */
  dashboardUrl(): string | null {
    const origin = this.device?.origin ?? this.state.serverOrigin;
    return origin ? new URL("/dashboard", origin).toString() : null;
  }

  /** The Dashboard's security page, where encryption can be turned off. */
  securityUrl(): string | null {
    const origin = this.device?.origin ?? this.state.serverOrigin;
    return origin ? new URL("/dashboard/account#security", origin).toString() : null;
  }

  // --- notices -----------------------------------------------------------------------------------------------

  private async readNotices(http: OwnerHttp, device: StoredDevice, summary: NowSummary | null): Promise<void> {
    if (this.phoneCheckedAt === null || this.now() - this.phoneCheckedAt >= PHONE_CHECK_MS) {
      try {
        const standing = await deviceStanding(http, device.accessToken);
        this.set({ phoneReceivesPushes: standing.phone, deviceTrusted: standing.thisTrusted });
        this.phoneCheckedAt = this.now();
      } catch (error) { if (isUnauthorized(error)) throw error; /* the last answer stands */ }
    }
    if (!showsNotices(this.state.phoneReceivesPushes)) {
      if (this.state.notices.length) this.set({ notices: [] });
      return;
    }
    try {
      const page = await fetchCurrentPage(http, device.accessToken, this.deps.crypto);
      if (this.device !== device) return;
      const nowIds = new Set((summary ? [...summary.needsYou, ...summary.recent, ...summary.waitingOnYou, ...summary.running, ...summary.quiet, ...summary.paused] : [])
        .flatMap((item) => item.notificationId ? [item.notificationId, item.id] : [item.id]));
      const found = noticesFrom(page.items, nowIds);
      const fresh = freshNotices(found, this.seen, page.serverTime);
      this.deps.note?.(`notices: current=${found.length} new=${fresh.length}`);
      await this.prefs.set(PREF.seen, JSON.stringify(this.seen.toArray()));
      this.set({
        notices: found,
        ...(fresh.length ? { noticeArrivals: { serial: this.state.noticeArrivals.serial + 1, notices: fresh } } : {}),
      });
    } catch (error) { if (isUnauthorized(error)) throw error; }
  }

  // --- questions and answers ---------------------------------------------------------------------------------

  private loadQuestions(summary: NowSummary): void {
    const open = new Map(summary.needsYou.flatMap((item) =>
      item.question?.standing === "pending" && item.notificationId ? [[item.notificationId, item] as const] : []));
    const questions = Object.fromEntries(Object.entries(this.state.questions).filter(([id]) => open.has(id)));
    const answers = Object.fromEntries(Object.entries(this.state.answers).filter(([id, a]) => open.has(id) || a.phase === "accepted"));
    this.set({ questions, answers });
    for (const id of open.keys()) if (!questions[id]) void this.loadQuestion(id);
  }

  private async loadQuestion(notificationId: string): Promise<void> {
    const device = this.device;
    if (!device) return;
    try {
      const question = await fetchQuestion(this.http(device.origin), device.accessToken, this.deps.crypto, notificationId);
      if (question && this.device === device) this.set({ questions: { ...this.state.questions, [notificationId]: question } });
    } catch (error) { if (isUnauthorized(error)) this.credentialRefused(); }
  }

  /** Sends one answer, signed with this device's identity key and bound to the sealed question it opened. */
  async answer(notificationId: string, action: AnswerAction, value: { optionId?: string; response?: string } = {}): Promise<void> {
    const device = this.device;
    if (!device || this.state.answers[notificationId]?.phase === "sending") return;
    this.setAnswer(notificationId, { phase: "sending" });
    try {
      const http = this.http(device.origin);
      // Read the question again: it may have been answered or replaced since it was shown.
      const question = await fetchQuestion(http, device.accessToken, this.deps.crypto, notificationId);
      if (!question) {
        this.setAnswer(notificationId, { phase: "failed", message: "Already answered or expired" });
        await this.fetch();
        return;
      }
      await submitAnswer({ http, crypto: this.deps.crypto, credential: device, question, action, ...value, now: this.now });
      this.setAnswer(notificationId, { phase: "accepted" });
      await this.fetch();
    } catch (error) {
      if (isUnauthorized(error)) this.credentialRefused();
      this.setAnswer(notificationId, { phase: "failed", message: this.message(error) });
    }
  }

  /** A missed question the owner has seen: the server drops it from Needs you, then Now is read again (Mac `dismissMissed`). */
  async dismissMissed(interactionId: string): Promise<boolean> {
    const device = this.device;
    if (!device) return false;
    let done = true;
    try {
      await dismissMissedQuestion(this.http(device.origin), device.accessToken, interactionId);
    } catch (error) {
      done = false;
      if (isUnauthorized(error)) this.credentialRefused();
    }
    await this.fetch();
    return done;
  }

  private setAnswer(id: string, phase: AnswerPhase): void { this.set({ answers: { ...this.state.answers, [id]: phase } }); }

  // --- since you looked --------------------------------------------------------------------------------------

  /** The Relo view came on screen: read Now relative to the last look. */
  async viewAppeared(): Promise<void> {
    this.visibleSince = this.now();
    if (this.since === null) this.since = await this.prefs.get(this.lookedKey());
    this.refreshNow();
  }

  /** The view left the screen: the owner looked if it was up for 2 s or more. */
  async viewDisappeared(): Promise<void> {
    const shown = this.visibleSince;
    this.visibleSince = null;
    if (shown === null || this.now() - shown < 2000) return;
    this.since = new Date(this.now()).toISOString();
    await this.prefs.set(this.lookedKey(), this.since);
  }

  private lookedKey(): string { return `${PREF.looked}|${this.device?.origin ?? ""}|${this.device?.accountId ?? ""}`; }

  // --- words -------------------------------------------------------------------------------------------------

  private message(error: unknown): string {
    if (this.device?.local === true) {
      if (error instanceof OwnerClientError) {
        if (error.kind === "unreachable") return LOCAL_WORDS.notAnswering;
        if (error.kind === "unauthorized" || error.kind === "forbidden") return LOCAL_WORDS.needsRepair;
        if (error.kind !== "rejected") return "Something went wrong on this PC.";
      } else return "Something went wrong on this PC.";
    }
    if (!(error instanceof OwnerClientError)) return "Something went wrong: unknown";
    switch (error.kind) {
      case "unreachable": return "The Relo server is unreachable.";
      case "unauthorized": return "Sign in again.";
      case "account_disabled": return "This account is disabled.";
      case "invalid_grant": return "That sign-in link expired. Sign in again.";
      case "state_mismatch": case "callback_malformed": return "The sign-in did not complete. Try again.";
      case "rate_limited": return "Too many tries. Wait a moment.";
      case "rejected": return ({
        superseded: "That question was replaced.", answered: "Already answered or expired", expired: "Already answered or expired",
        version_mismatch: "That question changed. Look again.", not_asked_copy: "Answer this on the copy the computer waits on.",
      } as Record<string, string>)[error.code ?? ""] ?? "That answer was not accepted.";
      default: return `Something went wrong: ${error.kind}${error.status ? ` ${error.status}` : ""}`;
    }
  }
}
