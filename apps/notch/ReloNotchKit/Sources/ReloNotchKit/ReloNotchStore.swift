import Foundation
import Observation
import OSLog
import ReloCore
import ReloNotificationSupport
import ReloPersistence
import ReloRuntime
import ReloTransport

/// The notch's Relo state: this Mac signed in as an owner device, the server's Now summary kept live,
/// and answers sent with this Mac's identity key. Like the iPhone, it displays the server's derivation
/// and stores no truth of its own.
@MainActor
@Observable
public final class ReloNotchStore {
    public enum Connection: Equatable, Sendable {
        case starting
        case signedOut
        case signingIn
        case connecting
        case live
        case offline
        /// The server refused this Mac's credential: sign in again.
        case needsSignIn
    }

    public struct Question: Equatable, Sendable {
        public var prompt: String
        public var kind: InboxInteraction.Kind
        public var options: [InteractionOption]
        public var expiresAt: Date
        /// False when the server only sent its placeholder (a sealed question this Mac cannot open): the prompt is
        /// empty and the owner answers on the iPhone.
        public var isReadable: Bool

        public init(prompt: String, kind: InboxInteraction.Kind, options: [InteractionOption], expiresAt: Date, isReadable: Bool = true) {
            self.prompt = prompt; self.kind = kind; self.options = options; self.expiresAt = expiresAt; self.isReadable = isReadable
        }
    }

    public enum AnswerPhase: Equatable, Sendable {
        case sending
        case accepted
        case failed(String)
    }

    public private(set) var connection: Connection = .starting
    public private(set) var summary: NowSummary?
    public private(set) var presentation: NotchPresentation = .empty
    /// Relo for Mac's own onboarding, shown in the notch as a staged work: never a server card. While set, it is the
    /// presentation; the server summary is still kept underneath and returns when it is cleared.
    @ObservationIgnored private var stagedOnboarding: NotchPresentation?
    private(set) var stagingFlag = false
    public var isStagingOnboarding: Bool { stagingFlag }
    public private(set) var accountEmail: String?
    public private(set) var problem: String?
    /// A browser sign-in that ended with "your account is waiting for approval": kept (Keychain) and asked about until
    /// the owner of the server decides. While set, this Mac is not blocked: local mode works and signing in follows by
    /// itself. Nil when nothing waits.
    public private(set) var pendingApproval: PendingSignIn?
    /// The app's reactions to the waiting account (it owns local mode and the switch to the server): a sign-in began to
    /// wait; the account was approved (the session is the app's to complete, see `completeApprovedSignIn`); the wait
    /// ended without approval.
    @ObservationIgnored public var onPendingStarted: (@MainActor (PendingSignIn) -> Void)?
    @ObservationIgnored public var onPendingApproved: (@MainActor (AccountSession, PendingSignIn) async -> Void)?
    @ObservationIgnored public var onPendingEnded: (@MainActor (PendingApproval.Finish, PendingSignIn) -> Void)?
    @ObservationIgnored var pendingStore: any PendingSignInStore = KeychainPendingSignInStore()
    @ObservationIgnored var pendingSender: PendingApproval.Sender = PendingApproval.urlSessionSender()
    @ObservationIgnored var pendingSleep: @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }
    @ObservationIgnored private var pendingWatch: Task<Void, Never>?
    /// Open questions by notification, read from the notification detail (prompt, kind, options).
    public private(set) var questions: [String: Question] = [:]
    public private(set) var answers: [String: AnswerPhase] = [:]
    /// The last time this Mac heard from the server, as the screens show it ("as of 10:42", "synced 10:42"): published
    /// at minute precision while live, so a read that changed nothing repaints nothing, and exactly when the connection
    /// drops (the moment "as of" and the frozen check start to matter). `lastHeard` keeps the precise time.
    public private(set) var lastUpdated: Date?
    @ObservationIgnored private var lastHeard: Date?
    /// The raw Now the screen was last built from (and the names it was opened with): an identical read is not applied again.
    @ObservationIgnored private var lastAppliedData: Data?
    /// The detached read in flight (decode, unseal, learn names): sign-out waits for it before forgetting keys.
    @ObservationIgnored private var nowWork: Task<NowResult, Error>?
    /// When the last applied Now was read, so a skipped read (same bytes, newer `serverTime`) does not stretch the wait.
    @ObservationIgnored private var lastAppliedAt = Date()
    @ObservationIgnored private var lastAppliedNames: [String: String]?
    /// Bumped whenever the screen's Now is forgotten (sign-out, a refused credential): the notch's moments watch it and
    /// forget their previous state, so nothing old is compared with, or replayed after, the next live Now.
    public private(set) var resetGeneration = 0
    @ObservationIgnored private var screenEpoch = 0
    @ObservationIgnored private var questionLoads: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var cachedAt: Date?
    @ObservationIgnored private var cacheExpiry: Task<Void, Never>?
    public private(set) var serverOrigin: URL?
    /// A computer of the account this Mac does not trust yet: its cards stay closed here until it is approved on
    /// this Mac or on any trusted device (docs/ENCRYPTION-PROTOCOL.md, "Computers are approved once").
    public struct WaitingComputer: Identifiable, Equatable, Sendable {
        public let id: String
        public let name: String
    }
    public private(set) var waitingComputers: [WaitingComputer] = []
    /// Local mode only: Relo's background server would not start at launch or after an update (the app sets it).
    public private(set) var localStartFailed = false

    /// Local mode only: Relo's server is being started or checked after launch. The notch says "Starting Relo…" until
    /// the app has finished, so a first read that finds the server still starting is never shown as "not answering".
    public var localStarting: Bool { localBooting && summary == nil }
    @ObservationIgnored private var localBooting = false
    /// The Now on screen is the last one this Mac read (a moment ago), until the server answers: the notch draws at
    /// once and swaps to live data without a spinner.
    public private(set) var showingCached = false
    @ObservationIgnored var nowCache = NowCache.standard
    @ObservationIgnored private var lastCachedData: Data?
    /// Whether the owner picked the server (typed it, or an install handed it over), as opposed to the build's own
    /// placeholder address: Sign in is offered only on a chosen one.
    public private(set) var originChosen = false
    /// The remote server's encryption choice (Settings), once read.
    public private(set) var encryption: EncryptionPolicy?
    /// Whether another device of the account is trusted (an iPhone), for the note under "Always".
    public private(set) var phoneTrusted = false

    /// Notices (`relo notify`) this Mac shows because no iPhone receives them: newest first, for the Recent list. Empty
    /// while an iPhone exists (it gets the push) and while this Mac has nothing to show.
    public private(set) var notices: [MacNotice] = []
    /// The notices that just arrived, for the notch's short moment.
    public private(set) var noticeArrivals = NoticeArrivals()
    /// Whether the account has an iPhone that receives pushes; nil until the device list has been read (remote only).
    public private(set) var phoneReceivesPushes: Bool?
    /// This Mac is the one that shows notices (local mode, or an account with no iPhone).
    public var showsNotices: Bool { MacNotices.shows(isLocal: isLocal, phoneReceivesPushes: phoneReceivesPushes) }

    /// Relo runs on this Mac (the app's local mode): no account, no encryption keys, no iPhone.
    public var isLocal: Bool { LocalMode.isOn() || linkingLocally }

    /// Why Relo's server did not start, in words (shown under "Relo couldn't start on this Mac").
    public private(set) var localStartDetail: String?

    public func setLocalStartFailed(_ failed: Bool, detail: String? = nil) {
        localStartFailed = failed
        localStartDetail = failed ? detail : nil
        // Relo's server is not running: what was read from it earlier is not the present.
        if failed, showingCached { dropCachedNow() }
    }
    public func setLocalStarting(_ starting: Bool) { localBooting = starting }

    /// Local mode: Relo's server listens on another port now (config.json): follow it. The credential only ever moves
    /// between loopback origins of this Mac, so it never reaches another server.
    public func followLocalPort(_ port: Int) {
        guard isLocal, credential != nil, let current = credentialOrigin, UpdatePolicy.isLoopback(current), current.port != port,
              let url = URL(string: "http://127.0.0.1:\(port)") else { return }
        credentialOrigin = url
        Self.storeCredentialOrigin(url)
        RuntimeServerOrigin.persist(url)
        serverOrigin = url
        startFeed()
        // The feed may have been cancelled mid-read (this can run from its own failed read): read once more soon.
        Task { try? await Task.sleep(for: .milliseconds(400)); refreshNow() }
    }

    @ObservationIgnored private let credentialStore = KeychainDeviceCredentialStore()
    @ObservationIgnored private let sessionStore = KeychainAccountSessionStore()
    @ObservationIgnored private let installationIDStore = KeychainInstallationIDStore()
    @ObservationIgnored private let stableDeviceIDStore = KeychainStableDeviceIDStore()
    @ObservationIgnored private var credential: DeviceCredential?
    /// The server the stored credential was made by: its token goes there and nowhere else.
    @ObservationIgnored private var credentialOrigin: URL?
    @ObservationIgnored private var linkingLocally = false
    /// Local mode: where config.json says Relo's server listens now (the app sets it); it can change on a restart.
    @ObservationIgnored public var localPortProvider: (@MainActor () -> Int?)?
    private static let credentialOriginKey = "relo.notch.credentialOrigin"
    @ObservationIgnored private var feedTask: Task<Void, Never>?
    @ObservationIgnored private var wakeTask: Task<Void, Never>?
    @ObservationIgnored private var fetching = false
    @ObservationIgnored private var refetchAfter = false
    @ObservationIgnored private var keysCheckedAt: Date?
    @ObservationIgnored private var listedComputers: [ReloClientKey] = []
    @ObservationIgnored private var seenNotices = SeenNotices.load()
    @ObservationIgnored private var phoneCheckedAt: Date?
    /// Computers trusted when Now was last opened: more of them means more cards open now.
    @ObservationIgnored private var trustedCount = -1
    /// Sealed-content tools with the Keychain held in memory (see SealedKit); tests swap in their own.
    @ObservationIgnored lazy var sealed = SealedKit.live()
    /// Counts reads of Now: a result is applied only if no later read's result was applied before it.
    @ObservationIgnored private var fetchGeneration = 0
    @ObservationIgnored private var appliedGeneration = 0
    /// The ids Now listed at the last apply (notices exclude them), kept for a read that changed nothing.
    @ObservationIgnored private var lastNowIDs: Set<String> = []
    /// Tests only: called at the start of the off-main work a Now read does.
    @ObservationIgnored var nowWorkProbe: (@Sendable () -> Void)?
    @ObservationIgnored private var started = false
    /// Each card's plan as rounds and nested steps, its labels opened from its sealed text on this Mac.
    @ObservationIgnored private(set) var plans: [String: PlanOutline] = [:]
    @ObservationIgnored private(set) var spokenLines: [String: SpokenText] = [:]
    /// The owner's last look on this Mac (a device fact): sent as `since`, written when the Relo tab
    /// was on screen for at least 2 s, like the iPhone's Now.
    @ObservationIgnored private var since: Date?
    @ObservationIgnored private var visibleSince: Date?

    public init() {}

    // MARK: Lifecycle

    /// Restores this Mac's credential and starts the live feed; safe to call more than once. `leaveLocal` is the app's
    /// way out of local mode, for an install script that adds this Mac to a server of the owner's.
    public func start(leaveLocal: (@MainActor () async -> Void)? = nil) {
        guard !started else { return }
        started = true
        sealedSetup()
        let launch = InstallerLaunch(arguments: CommandLine.arguments)
        Self.migrateLegacyDefaults()
        // Draw at once from the last Now this Mac read (local mode only: its cards are never sealed).
        let leaving = launch?.origin.map { !UpdatePolicy.isLoopback($0) } ?? false
        if isLocal, !leaving, let data = nowCache.load(),
           let cached = try? ReloWireJSON.decoder().decode(NowSummary.self, from: data) {
            let modified = (try? FileManager.default.attributesOfItem(atPath: nowCache.url.path))?[.modificationDate] as? Date
            showCachedNow(cached, data: data, modified: modified ?? Date())
        }
        // The Keychain is read off the main actor: the notch is on screen before it answers.
        let credentials = credentialStore, sessions = sessionStore, pendings = pendingStore
        Task { [weak self] in
            let loaded = await Task.detached(priority: .userInitiated) { () -> (DeviceCredential?, String?, PendingSignIn?) in
                let credential = try? credentials.load()
                let session = try? sessions.load()
                return (credential, session?.account?.email ?? session?.user.email, try? pendings.load())
            }.value
            self?.finishStart(launch: launch, credential: loaded.0, email: loaded.1, leaveLocal: leaveLocal, pending: loaded.2)
        }
    }

    private func finishStart(launch: InstallerLaunch?, credential loaded: DeviceCredential?, email: String?,
                             leaveLocal: (@MainActor () async -> Void)?, pending: PendingSignIn? = nil) {
        credential = loaded
        // A waiting account is asked about again at launch (also while Relo runs on this Mac meanwhile). A Mac already
        // signed in to a server of its own has nothing to wait for.
        restorePending(pending, hasServerCredential: loaded != nil && !isLocal)
        credentialOrigin = credential == nil ? nil : Self.originOfStoredCredential(
            stored: Self.storedCredentialOrigin(), chosen: RuntimeServerOrigin.chosen(),
            local: isLocal ? localPortProvider?().flatMap { URL(string: "http://127.0.0.1:\($0)") } : nil,
            bundled: Self.bundledOrigin())
        if credential != nil, let credentialOrigin {
            Self.storeCredentialOrigin(credentialOrigin)
            if !isLocal || UpdatePolicy.isLoopback(credentialOrigin) { RuntimeServerOrigin.persist(credentialOrigin) }
        }
        accountEmail = email
        if credential == nil, showingCached { dropCachedNow() }
        // Opened by the install script (Add a computer with Relo for Mac) onto a Mac that runs Relo itself: leave
        // local mode first, then sign in to that server. The local credential is never sent to another origin.
        if let launch, let origin = launch.origin, isLocal, !UpdatePolicy.isLoopback(origin) {
            guard let code = launch.signInCode, let verifier = launch.codeVerifier else {
                serverOrigin = credentialOrigin ?? RuntimeServerOrigin.current()
                originChosen = RuntimeServerOrigin.chosen() != nil
                startFromStoredCredential()
                return
            }
            connection = .signingIn
            Task {
                await leaveLocal?()
                if credential != nil { await signOut() }
                await completeSignIn(code: code, verifier: verifier, origin: origin, previous: .signedOut)
            }
            return
        }
        // The launch origin is kept only when it cannot differ from a stored credential's.
        if let origin = launch?.origin, !isLocal, credential == nil || credentialOrigin == origin {
            RuntimeServerOrigin.persist(origin)
        }
        serverOrigin = credentialOrigin ?? RuntimeServerOrigin.current()
        originChosen = RuntimeServerOrigin.chosen() != nil
        // Opened by the install script (Add a computer with Relo for Mac): sign in with the code it was handed.
        if credential == nil, !isLocal, let launch, let code = launch.signInCode, let verifier = launch.codeVerifier,
           let origin = launch.origin {
            connection = .signingIn
            Task { await completeSignIn(code: code, verifier: verifier, origin: origin, previous: .signedOut) }
            return
        }
        startFromStoredCredential()
        // Local mode: the server may listen on another port than the one stored with the credential.
        if isLocal, let port = localPortProvider?() { followLocalPort(port) }
    }

    /// Shows `staged` as the whole presentation (nil clears it: the latest summary's presentation returns at once).
    public func stageOnboarding(_ staged: NotchPresentation?) {
        stagedOnboarding = staged
        stagingFlag = staged != nil
        presentation = staged ?? NotchPresentation(summary: summary, plans: plans, spoken: spokenLines)
    }

    /// Shows the last Now this Mac read until the server answers; it is dropped after the cache's age limit (10 min)
    /// without live data. `modified` is when the cache was written.
    func showCachedNow(_ cached: NowSummary, data: Data, modified: Date = Date()) {
        plans = Self.planOutlines(cached, open: { _, _ in nil })
        summary = cached
        if stagedOnboarding == nil { presentation = NotchPresentation(summary: cached, plans: plans, spoken: [:]) }
        showingCached = true
        connection = .connecting
        lastCachedData = data
        lastAppliedData = nil
        cachedAt = modified
        cacheExpiry?.cancel()
        let wait = max(0, nowCache.maxAge - Date().timeIntervalSince(modified))
        cacheExpiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait + 0.5))
            guard !Task.isCancelled else { return }
            self?.expireCachedNow()
        }
    }

    /// The cached Now goes when it is older than the cache's age limit and no live data replaced it.
    func expireCachedNow(now: Date = Date()) {
        guard showingCached, let cachedAt, now.timeIntervalSince(cachedAt) >= nowCache.maxAge else { return }
        dropCachedNow()
    }

    private func dropCachedNow() {
        summary = nil; if stagedOnboarding == nil { presentation = .empty }; plans = [:]; spokenLines = [:]; showingCached = false
        lastAppliedData = nil
        lastCachedData = nil; cacheExpiry?.cancel(); cacheExpiry = nil
        if connection == .connecting { connection = .starting }
    }

    private func startFromStoredCredential() {
        guard credential != nil, credentialOrigin != nil else {
            connection = .signedOut
            return
        }
        startFeed()
        Task { await refreshRegistrationIfNeeded() }
    }

    /// The server a credential found at launch belongs to: the one stored with it, else the one the owner chose, else
    /// this Mac's own (local mode), else the build's address when that is a real host. The build's placeholder
    /// (relo.invalid) is never one, so a credential without a known server asks for a sign-in instead of being sent
    /// somewhere it was not made for.
    static func originOfStoredCredential(stored: URL?, chosen: URL?, local: URL?, bundled: URL?) -> URL? {
        stored ?? chosen ?? local ?? bundled
    }

    /// The build's `RELOAPIOrigin` when it names a real host.
    static func bundledOrigin(bundle: Bundle = .main) -> URL? {
        guard let text = bundle.object(forInfoDictionaryKey: "RELOAPIOrigin") as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: trimmed), let host = url.host(), host.contains("."),
              !host.hasSuffix(".invalid"), !host.hasSuffix(".example.com"),
              let origin = DashboardURLProvider(origin: url)?.origin else { return nil }
        return origin
    }

    private static let legacyMigratedKey = "relo.notch.legacyDefaultsMigrated"

    /// This build is not sandboxed, so its preferences moved out of the old container
    /// (`~/Library/Containers/<bundle id>/Data/Library/Preferences/<bundle id>.plist`). Once, Relo's own keys (`relo.…`)
    /// that are missing now are copied from there, so an existing install keeps its server, mode and choices.
    @discardableResult
    public static func migrateLegacyDefaults(bundleIdentifier: String? = Bundle.main.bundleIdentifier,
                                             home: URL = FileManager.default.homeDirectoryForCurrentUser,
                                             defaults: UserDefaults = .standard) -> Int {
        guard let bundleIdentifier, !defaults.bool(forKey: legacyMigratedKey) else { return 0 }
        let plist = home.appendingPathComponent("Library/Containers/\(bundleIdentifier)/Data/Library/Preferences/\(bundleIdentifier).plist")
        guard FileManager.default.fileExists(atPath: plist.path) else { return 0 }
        defaults.set(true, forKey: legacyMigratedKey)
        guard let data = try? Data(contentsOf: plist),
              let old = (try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)) as? [String: Any] else { return 0 }
        var copied = 0
        for (key, value) in old where key.hasPrefix("relo.") && key != legacyMigratedKey && defaults.object(forKey: key) == nil {
            defaults.set(value, forKey: key)
            copied += 1
        }
        return copied
    }

    private static func storedCredentialOrigin() -> URL? {
        UserDefaults.standard.string(forKey: credentialOriginKey).flatMap(URL.init(string:))
    }

    private static func storeCredentialOrigin(_ origin: URL?) {
        if let origin { UserDefaults.standard.set(origin.absoluteString, forKey: credentialOriginKey) }
        else { UserDefaults.standard.removeObject(forKey: credentialOriginKey) }
    }

    /// A build that declares different capabilities registers again once (with the stored account
    /// session), so the server reads this Mac as what it now is (an owner overview).
    private func refreshRegistrationIfNeeded() async {
        let key = "relo.notch.registeredCapabilities"
        let wanted = MacDevice.capabilities.sorted().joined(separator: ",")
        guard UserDefaults.standard.string(forKey: key) != wanted,
              let session = try? sessionStore.load(), let origin = credentialOrigin,
              let installationId = try? installationIDStore.loadOrCreate() else { return }
        do {
            try await register(session: session, origin: origin, installationId: installationId)
            Self.log.notice("registered again with \(wanted, privacy: .public)")
            startFeed()
        } catch {
            Self.log.error("registering again failed: \(String(describing: error), privacy: .public)")
            problem = Self.message(for: error, local: isLocal)
        }
    }

    /// The Mac woke or the network came back: read Now again right away.
    public func refreshNow() {
        guard credential != nil else { return }
        Task { await fetch() }
    }

    /// The server address as the owner reads and types it: the scheme, the host and a port that is not the scheme's own
    /// ("https://relo.example.com", "http://192.168.1.5:8180").
    public nonisolated static func displayAddress(of origin: URL) -> String {
        guard let scheme = origin.scheme, let host = origin.host(percentEncoded: false) else { return origin.absoluteString }
        let shownHost = host.contains(":") ? "[\(host)]" : host
        let isDefaultPort = origin.port == nil || (scheme == "https" && origin.port == 443) || (scheme == "http" && origin.port == 80)
        return "\(scheme)://\(shownHost)\(isDefaultPort ? "" : ":\(origin.port!)")"
    }

    /// The origin a typed address names: a scheme and port the owner typed are kept, and `https://` is added only when
    /// there is no scheme. Anything after the host (a path, a query) is dropped.
    public nonisolated static func origin(fromTypedAddress text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var parts = URLComponents(string: withScheme), parts.host?.isEmpty == false else { return nil }
        parts.path = ""; parts.query = nil; parts.fragment = nil; parts.user = nil; parts.password = nil
        guard let url = parts.url else { return nil }
        return DashboardURLProvider(origin: url)?.origin
    }

    public func setServerOrigin(_ text: String) -> Bool {
        guard let origin = Self.origin(fromTypedAddress: text) else { return false }
        RuntimeServerOrigin.persist(origin)
        serverOrigin = origin
        originChosen = true
        return true
    }

    /// The address a signed-out Mac suggests in its server field: the build's own when it is a real server, else blank.
    /// The address a signed-out Mac suggests in its server field: the build's own when it is a real server, else blank.
    public func suggestedServerAddress(bundle: Bundle = .main) -> String {
        Self.bundledOrigin(bundle: bundle).map(Self.displayAddress(of:)) ?? ""
    }

    private func sealedSetup() {
        let kit = sealed
        ReloSealedCards.install(kit.content.cardOpener())
        ReloSealedCards.installNames { kit.names.names() }
        Task.detached(priority: .utility) { kit.warm() }
    }

    // MARK: Sign-in and registration

    /// Bumped when the owner gives up on a sign-in (chose this Mac instead): one that comes back later is dropped, so
    /// it never signs this Mac in to a server behind the local setup.
    private var signInAttempt = 0

    /// Gives up on a browser sign-in in progress: the web sheet closes and this Mac stays signed out of the server.
    public func cancelSignIn() {
        guard connection == .signingIn, !linkingLocally else { return }
        signInAttempt += 1
        BrowserSignInSession.cancel()
        connection = credential == nil ? .signedOut : .needsSignIn
    }

    public func signIn() async {
        guard connection != .signingIn else { return }
        let attempt = signInAttempt
        guard originChosen, let origin = serverOrigin else {
            problem = "Enter your Relo server's address first."
            return
        }
        problem = nil
        let previous = connection
        connection = .signingIn
        let flow = BrowserSignIn()
        guard let url = flow.authorizationURL(origin: origin) else {
            problem = "That server address is not valid."
            connection = previous
            return
        }
        do {
            let callback: URL
            do { callback = try await BrowserSignInSession.authenticate(url: url) }
            catch BrowserSignInSession.Failure.cancelled {
                if attempt == signInAttempt { connection = previous == .starting ? .signedOut : previous }
                return
            }
            guard attempt == signInAttempt else { return }
            if let ticket = try PendingSignInCallback.ticket(in: callback, flow: flow) {
                beginPendingApproval(ticket: ticket, flow: flow, origin: origin)
                connection = previous == .starting ? .signedOut : previous
                return
            }
            guard case .code(let code) = try flow.parse(callback: callback) else {
                connection = previous == .starting ? .signedOut : previous
                return
            }
            await completeSignIn(code: code, verifier: flow.verifier, origin: origin, previous: previous, attempt: attempt)
        } catch {
            guard attempt == signInAttempt else { return }
            problem = Self.message(for: error, local: isLocal)
            connection = credential == nil ? .signedOut : .needsSignIn
        }
    }

    /// Local mode: signs this Mac in to the server on it with the code the CLI's join returned (no browser). The
    /// local flag is set here, only once the sign-in worked.
    public func signInLocally(code: String, verifier: String, origin: URL) async {
        started = true
        connection = .signingIn
        problem = nil
        linkingLocally = true
        defer { linkingLocally = false }
        await completeSignIn(code: code, verifier: verifier, origin: origin, previous: .signedOut)
        if [.connecting, .live, .offline].contains(connection) { LocalMode.set(true) }
    }

    /// Forgets the chosen server (leaving local mode) so the next sign-in names a new one.
    public func forgetServerOrigin(bundle: Bundle = .main) {
        UserDefaults.standard.removeObject(forKey: RuntimeServerOrigin.defaultsKey)
        if let group = bundle.object(forInfoDictionaryKey: "RELOAppGroup") as? String {
            UserDefaults(suiteName: group)?.removeObject(forKey: RuntimeServerOrigin.defaultsKey)
        }
        serverOrigin = RuntimeServerOrigin.current(bundle: bundle)
        originChosen = false
    }

    /// Exchanges a one-time sign-in code (from the browser sheet, or handed over by the install script) for an
    /// account session, then registers this Mac.
    private func completeSignIn(code: String, verifier: String, origin: URL, previous: Connection, attempt: Int? = nil) async {
        do {
            let api = HTTPMobileAPIClient(baseURL: origin)
            let installationId = try installationIDStore.loadOrCreate()
            let session = try await api.exchangeBrowserSignIn(
                code: code, codeVerifier: verifier, installationId: installationId.uuidString.lowercased()
            )
            // Given up on while the code was exchanged: nothing of it is kept.
            if let attempt, attempt != signInAttempt { return }
            try await finishSignIn(session: session, origin: origin, installationId: installationId)
        } catch {
            Self.log.error("sign-in failed: \(String(describing: error), privacy: .public)")
            problem = Self.message(for: error, local: isLocal)
            connection = credential == nil ? .signedOut : .needsSignIn
        }
    }

    /// The account session is in hand (from a code, or from an approved request): keep it, register this Mac, follow Now.
    private func finishSignIn(session: AccountSession, origin: URL, installationId: UUID) async throws {
        try sessionStore.save(session)
        try await register(session: session, origin: origin, installationId: installationId)
        startFeed()
        // Signed in to a server: a request that waited for it has nothing left to ask (this Mac's own server is not it).
        if !linkingLocally, !UpdatePolicy.isLoopback(origin) { dropPendingApproval() }
    }

    // MARK: A sign-in waiting for approval

    private func beginPendingApproval(ticket: String, flow: BrowserSignIn, origin: URL) {
        let installation = (try? installationIDStore.loadOrCreate())?.uuidString.lowercased() ?? ""
        let pending = PendingSignIn(origin: origin, ticket: ticket, codeVerifier: flow.verifier, installationId: installation,
                                    startedAt: Date())
        do { try pendingStore.save(pending) }
        catch { Self.log.error("pending sign-in not saved: \(String(describing: error), privacy: .public)") }
        problem = nil
        pendingApproval = pending
        startPendingWatch()
        onPendingStarted?(pending)
    }

    /// The pending sign-in found at launch: asked about again, unless this Mac is signed in to a server already.
    func restorePending(_ pending: PendingSignIn?, hasServerCredential: Bool) {
        guard let pending else { return }
        if hasServerCredential { try? pendingStore.delete(); return }
        pendingApproval = pending
        startPendingWatch()
        onPendingStarted?(pending)
    }

    private func startPendingWatch() {
        pendingWatch?.cancel()
        guard let pending = pendingApproval else { return }
        let send = pendingSender, sleep = pendingSleep
        pendingWatch = Task { [weak self] in
            let finish = await PendingApproval.watch(pending, send: send, sleep: sleep)
            guard !Task.isCancelled, let self, self.pendingApproval == pending else { return }
            await self.pendingFinished(finish, pending)
        }
    }

    func pendingFinished(_ finish: PendingApproval.Finish, _ pending: PendingSignIn) async {
        // Whatever the answer, the ticket is spent: an approval consumed it, the rest cannot become one.
        dropPendingApproval()
        switch finish {
        case .cancelled: return
        case .approved(let session):
            if let onPendingApproved { await onPendingApproved(session, pending) }
            else { _ = await completeApprovedSignIn(session, pending: pending) }
        case .declined, .expired, .invalid:
            problem = PendingApproval.endedLine(finish, host: pending.host)
            onPendingEnded?(finish, pending)
        }
    }

    /// "Cancel request": forgets the ticket. The account stays waiting on the server; signing in again asks once more.
    public func cancelPendingApproval() {
        dropPendingApproval()
    }

    private func dropPendingApproval() {
        pendingWatch?.cancel(); pendingWatch = nil
        pendingApproval = nil
        try? pendingStore.delete()
    }

    /// The account was approved: signs this Mac in to its server with the session the server returned. The caller left
    /// local mode first when it had to. False (with a plain `problem`) when it did not work; the owner signs in again.
    public func completeApprovedSignIn(_ session: AccountSession, pending: PendingSignIn) async -> Bool {
        connection = .signingIn
        problem = nil
        do {
            let installation = try UUID(uuidString: pending.installationId) ?? installationIDStore.loadOrCreate()
            try await finishSignIn(session: session, origin: pending.origin, installationId: installation)
            ModeSwitch.remember(server: pending.origin)
            return true
        } catch {
            Self.log.error("approved sign-in failed: \(String(describing: error), privacy: .public)")
            problem = PendingApproval.approvedNotFinished(host: pending.host)
            connection = credential == nil ? .signedOut : .needsSignIn
            return false
        }
    }

    private func register(session: AccountSession, origin: URL, installationId: UUID) async throws {
        connection = .connecting
        let api = HTTPMobileAPIClient(baseURL: origin)
        let request = MacDevice.registrationRequest(
            stableDeviceId: try stableDeviceIDStore.loadOrCreate(), installationId: installationId
        )
        // A fresh key per sign-in: the server replays an identical request on the same key.
        let key = "mac-register:\(installationId.uuidString.lowercased()):\(session.sessionId):\(Int(Date().timeIntervalSince1970))"
        let response = try await api.registerDevice(sessionToken: session.accessToken, request: request, idempotencyKey: key)
        let newCredential = DeviceCredential(
            deviceId: response.device.deviceId,
            installationId: response.device.installationId,
            accessToken: response.credential.accessToken,
            issuedAt: response.credential.issuedAt,
            expiresAt: response.credential.expiresAt,
            accountId: response.account.accountId,
            credentialVersion: response.device.credentialVersion
        )
        try credentialStore.save(newCredential)
        try sessionStore.save(session.attaching(account: response.account))
        credential = newCredential
        // The origin is kept only now, with the credential it made: they never differ.
        credentialOrigin = origin
        Self.storeCredentialOrigin(origin)
        RuntimeServerOrigin.persist(origin)
        serverOrigin = origin
        originChosen = true
        accountEmail = response.account.email
        UserDefaults.standard.set(MacDevice.capabilities.sorted().joined(separator: ","), forKey: "relo.notch.registeredCapabilities")
        keysCheckedAt = nil
        // Nothing leaves this Mac in local mode, so nothing is sealed and no key is published.
        if !isLocal { await maintainKeys(force: true) }
    }

    public func signOut() async {
        feedTask?.cancel(); feedTask = nil
        wakeTask?.cancel(); wakeTask = nil
        if let credential, let origin = credentialOrigin {
            try? await HTTPMobileAPIClient(baseURL: origin).revokeDevice(credential: credential)
        }
        if let session = try? sessionStore.load(), let origin = credentialOrigin {
            try? await HTTPMobileAPIClient(baseURL: origin).signOutAccount(sessionToken: session.accessToken)
        }
        try? credentialStore.delete()
        try? sessionStore.delete()
        // The detached read may still be learning names or recording replays: it ends before the keys are forgotten.
        await finishNowWork()
        ReloEncryptionState.forget()
        sealed.invalidate()
        credential = nil
        credentialOrigin = nil
        Self.storeCredentialOrigin(nil)
        encryption = nil
        since = nil
        clearScreen()
        phoneReceivesPushes = nil
        phoneCheckedAt = nil
        accountEmail = nil
        connection = .signedOut
    }

    // MARK: Encryption keys

    /// Publishes this Mac's encryption keys and rotates its prekey when due. Publishing a new device's
    /// keys asks the account's iPhone to approve it; until then sealed text stays closed here.
    private func maintainKeys(force: Bool = false) async {
        guard !isLocal, let credential, let origin = credentialOrigin else { return }
        // Hourly, or every two minutes while something here stays closed: an approval on another device opens it.
        let interval: TimeInterval = presentation.hasUnreadable || !waitingComputers.isEmpty ? 120 : 3600
        if !force, let checked = keysCheckedAt, Date().timeIntervalSince(checked) < interval { return }
        keysCheckedAt = Date()
        let api = HTTPMobileAPIClient(baseURL: origin)
        // Computers approved on any trusted device open here, and this Mac signs approvals for the ones it trusts
        // (docs/ENCRYPTION-PROTOCOL.md, "Computers are approved once").
        let kit = sealed
        let maintenance = E2EEKeyMaintenance(ring: kit.ring, publisher: api, directory: api, trust: kit.trust,
                                             erase: { ReloEncryptionState.forget() }, approving: api, approvers: .live())
        defer { kit.invalidate() }
        do {
            try await maintenance.run(credential: credential)
        } catch {
            Self.log.error("keys: publishing failed: \(String(describing: error), privacy: .public)")
            keysCheckedAt = nil
            problem = "This Mac's encryption keys were not published yet; Relo will retry."
        }
        // The account's computers were trusted (on first use, or approved on any trusted device) by the
        // maintenance above; a change opens again what was already fetched.
        kit.invalidate()
        let trust = kit.trust
        do {
            let computers = try await api.clientKeys(credential: credential)
            listedComputers = computers
            let listed = Set(computers.map(\.clientId))
            waitingComputers = try trust.pending().filter { listed.contains($0.clientId) }
                .map { WaitingComputer(id: $0.clientId, name: $0.name) }
            let trusted = try trust.trustedSenders().count
            Self.log.notice("trust: computers=\(computers.count) trusted=\(trusted)")
            if trusted != trustedCount {
                trustedCount = trusted
                lastAppliedData = nil
                await fetch()
            }
        } catch {
            Self.log.error("trust: \(String(describing: error), privacy: .public)")
        }
    }

    /// The owner approves a waiting computer on this Mac: its cards open here, and this Mac's signed approval
    /// opens them on the account's other devices too.
    public func approveComputer(id: String) async {
        guard let credential, let origin = credentialOrigin,
              let computer = listedComputers.first(where: { $0.clientId == id }) else { return }
        do {
            try sealed.trust.approve(clientId: computer.clientId, keyId: computer.keyId)
        } catch {
            problem = "Relo could not approve \(computer.name) on this Mac. Try again."
            return
        }
        waitingComputers.removeAll { $0.id == id }
        let api = HTTPMobileAPIClient(baseURL: origin)
        let kit = sealed
        await E2EEKeyMaintenance(ring: kit.ring, publisher: api, directory: api, trust: kit.trust, approving: api, approvers: .live())
            .approve(computer, credential: credential)
        kit.invalidate()
        trustedCount = -1
        lastAppliedData = nil
        await fetch()
    }

    /// Declined on this Mac: the computer stays listed and its cards stay closed here.
    public func declineComputer(id: String) {
        guard let computer = listedComputers.first(where: { $0.clientId == id }) else { return }
        try? sealed.trust.decline(clientId: computer.clientId, keyId: computer.keyId)
        waitingComputers.removeAll { $0.id == id }
    }

    // MARK: The live feed

    private func startFeed() {
        feedTask?.cancel()
        guard let credential, let origin = credentialOrigin else { return }
        if connection != .live { connection = .connecting }
        feedTask = Task { [weak self] in
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await self?.followChanges(origin: origin, token: credential.accessToken) }
                group.addTask { await self?.tick() }
            }
        }
    }

    /// The server's change stream: each hint asks for a fresh Now (coalesced). It reconnects by itself;
    /// it ends only when the credential is refused.
    private func followChanges(origin: URL, token: String) async {
        while !Task.isCancelled {
            let source = HTTPCurrentStateSource(baseURL: origin, token: token)
            do {
                for try await _ in source.changes() { wake() }
            } catch InboxRemoteError.unauthorized {
                credentialRefused()
                return
            } catch {}
            try? await Task.sleep(for: .seconds(5))
        }
    }

    /// The 60 s safety tick, or sooner at the server's `refreshAt`; keys are checked hourly.
    private func tick() async {
        while !Task.isCancelled {
            await fetch()
            await maintainKeys()
            try? await Task.sleep(for: .seconds(nextWait()))
        }
    }

    private func wake() {
        guard wakeTask == nil else { return }
        wakeTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(750))
            guard let self, !Task.isCancelled else { return }
            self.wakeTask = nil
            await self.fetch()
        }
    }

    /// Cancels the detached read and waits for it to end (it cannot be interrupted mid-decode, so it finishes first).
    private func finishNowWork() async {
        guard let work = nowWork else { return }
        work.cancel()
        _ = try? await work.value
        nowWork = nil
    }

    private func nextWait() -> TimeInterval {
        guard let summary, let refreshAt = summary.refreshAt else { return 60 }
        let elapsed = max(0, Date().timeIntervalSince(lastAppliedAt))
        let wait = refreshAt.timeIntervalSince(summary.serverTime) - elapsed + 1
        return wait > 0 && wait < 60 ? wait : 60
    }

    private func fetch() async {
        guard !fetching else { refetchAfter = true; return }
        fetching = true
        repeat {
            refetchAfter = false
            await fetchOnce()
        } while refetchAfter && !Task.isCancelled
        fetching = false
        // A feed restart cancelled this read while another was queued behind it: that one still happens.
        if refetchAfter {
            refetchAfter = false
            Task { await fetch() }
        }
    }

    private func fetchOnce() async {
        guard let credential, let origin = credentialOrigin else { return }
        let kit = sealed
        let epoch = screenEpoch
        fetchGeneration += 1
        let generation = fetchGeneration
        let source = HTTPNowSource(baseURL: origin, token: credential.accessToken, nameResolver: kit.content.nameResolver)
        do {
            let data = try await source.fetchNowData(since: since.map { min($0, Date()) })
            guard self.credential == credential, epoch == screenEpoch else { return }
            if connection != .live { publishHeard() }
            if Self.sameNow(data, lastAppliedData), kit.names.names() == lastAppliedNames, !showingCached, summary != nil {
                // Nothing changed (the server's own clock aside): only the time we heard from the server moves, and
                // nothing is decoded or opened. A question that failed to load still gets its retry.
                heardFromServer()
                if let summary { loadOpenQuestions(summary) }
            } else {
                let probe = nowWorkProbe
                let token = credential.accessToken
                let work = Task.detached(priority: .userInitiated) {
                    try Self.processNow(data, baseURL: origin, token: token, kit: kit, probe: probe)
                }
                nowWork = work
                defer { if nowWork == work { nowWork = nil } }
                let result = try await work.value
                try Task.checkCancellation()
                // A newer read may have applied while this one worked off the main actor: its result stays.
                guard self.credential == credential, epoch == screenEpoch, generation > appliedGeneration else { return }
                appliedGeneration = generation
                apply(result)
                lastAppliedAt = Date()
                lastAppliedData = data
                lastAppliedNames = result.names
            }
            setIfChanged(\.connection, .live)
            setIfChanged(\.problem, nil)
            setIfChanged(\.showingCached, false)
            LaunchClock.mark("live data")
            if isLocal, data != lastCachedData {
                lastCachedData = data
                let cache = nowCache
                Task.detached(priority: .utility) { cache.save(data) }
            }
            await readNotices(origin: origin, credential: credential, nowIDs: lastNowIDs)
        } catch is CancellationError {
        } catch InboxRemoteError.unauthorized {
            Self.log.error("now: refused (sign in again)")
            credentialRefused()
        } catch {
            Self.log.error("now: fetch failed: \(String(describing: error), privacy: .public)")
            // Local mode, right after launch: the app is still starting Relo's server, which is not "not answering".
            if !localBooting { setIfChanged(\.connection, .offline) }
            publishHeard()
            expireCachedNow()
            if isLocal, let port = localPortProvider?() { followLocalPort(port) }
        }
    }

    /// Whether two reads of Now are the same apart from the server's own clock (`serverTime`, stamped into every
    /// response): the bytes are compared with that one value blanked, before anything is decoded.
    nonisolated static func sameNow(_ new: Data, _ old: Data?) -> Bool {
        guard let old else { return false }
        if new == old { return true }
        guard abs(new.count - old.count) < 64 else { return false }
        return withoutServerTime(new) == withoutServerTime(old)
    }

    nonisolated static func withoutServerTime(_ data: Data) -> Data {
        let key = Array("\"serverTime\"".utf8)
        let bytes = Array(data)
        var out = [UInt8]()
        out.reserveCapacity(bytes.count)
        var i = 0
        while i < bytes.count {
            if bytes[i] == key[0], i + key.count <= bytes.count, bytes[i..<i + key.count].elementsEqual(key) {
                out.append(contentsOf: key)
                i += key.count
                while i < bytes.count, bytes[i] == 0x20 || bytes[i] == 0x0A || bytes[i] == 0x09 || bytes[i] == 0x0D { i += 1 }
                guard i < bytes.count, bytes[i] == 0x3A else { continue }
                out.append(0x3A); i += 1
                while i < bytes.count, bytes[i] == 0x20 || bytes[i] == 0x0A || bytes[i] == 0x09 || bytes[i] == 0x0D { i += 1 }
                if i < bytes.count, bytes[i] == 0x22 {
                    i += 1
                    while i < bytes.count, bytes[i] != 0x22 { i += bytes[i] == 0x5C ? 2 : 1 }
                    i += 1
                } else {
                    while i < bytes.count, ![0x2C, 0x7D, 0x5D, 0x20, 0x0A, 0x0D, 0x09].contains(bytes[i]) { i += 1 }
                }
                continue
            }
            out.append(bytes[i])
            i += 1
        }
        return Data(out)
    }

    /// What a read of Now becomes once decoded, opened and named: everything the screens need, built off the main actor.
    struct NowResult: Sendable {
        let summary: NowSummary
        let names: [String: String]
        let plans: [String: PlanOutline]
        let spoken: [String: SpokenText]
        let presentation: NotchPresentation
        let ids: Set<String>
    }

    /// Decode, name resolution, signature checks, unsealing, plan outlines, spoken lines and the presentation: all CPU
    /// and Keychain-bound work of a read, with no main-actor state. The main actor only applies the result.
    nonisolated static func processNow(_ data: Data, baseURL: URL, token: String, kit: SealedKit,
                                       probe: (@Sendable () -> Void)? = nil) throws -> NowResult {
        probe?()
        let source = HTTPNowSource(baseURL: baseURL, token: token, nameResolver: kit.content.nameResolver)
        let open = {
            try source.decode(data).openingSessionNames(kit.content.opener)
                .openingSealed(kit.content.displayOpener, diagnose: kit.content.diagnoser)
        }
        // Handles are named at decode, from the names known before this read; opening its envelopes can teach new
        // ones (a new project, computer or session), so a read that taught any is decoded again with them.
        let known = kit.names.names()
        var opened = try open()
        if kit.names.names() != known { opened = try open() }
        let names = kit.names.names()
        let plans = planOutlines(opened, open: kit.content.displayOpener)
        let spoken = spokenLines(opened, open: kit.content.displayOpener)
        let ids = Set(opened.allItems.flatMap { [$0.id] + [$0.notificationId].compactMap { $0 } })
        return NowResult(summary: opened, names: names, plans: plans, spoken: spoken,
                         presentation: NotchPresentation(summary: opened, plans: plans, spoken: spoken), ids: ids)
    }

    private func apply(_ result: NowResult) {
        setIfChanged(\.plans, result.plans)
        setIfChanged(\.spokenLines, result.spoken)
        receive(result.summary, presentation: result.presentation)
        lastNowIDs = result.ids
    }

    /// Tests only: everything a read does once its bytes arrived.
    func applyNowDataForTesting(_ data: Data, origin: URL, token: String, generation given: Int? = nil) async throws {
        fetchGeneration += 1
        let generation = given ?? fetchGeneration
        let kit = sealed
        let probe = nowWorkProbe
        let result = try await Task.detached(priority: .userInitiated) {
            try Self.processNow(data, baseURL: origin, token: token, kit: kit, probe: probe)
        }.value
        guard generation > appliedGeneration else { return }
        appliedGeneration = generation
        apply(result)
    }

    /// Signed out, without a server (snapshots and previews); never used by the live app.
    public func showSignedOutPreview() {
        started = true
        connection = .signedOut
    }

    /// Shows a summary without a server (snapshots and previews); never used by the live app.
    public func showPreview(_ summary: NowSummary, questions: [String: Question] = [:]) {
        started = true
        connection = .live
        plans = Self.planOutlines(summary, open: { _, _ in nil })
        receive(summary)
        self.questions = questions
    }

    private static let log = Logger(subsystem: "relo.notch", category: "now")

    func receive(_ summary: NowSummary, presentation built: NotchPresentation? = nil) {
        // Counts only: never titles or text (they may be private).
        Self.log.notice("now: needsYou=\(summary.needsYou.count) running=\(summary.running.count) recent=\(summary.recent.count) yourTurn=\(summary.waitingOnYou.count) quiet=\(summary.quiet.count) sessions=\(summary.sessions.sessions.count) focus=\(summary.lockScreen.focus != nil) unreadable=\(summary.allItems.filter { ReloSealedCards.isPlaceholderTitle($0.title) || $0.title == ReloSealedCards.unreadableTitle }.count)")
        let reasons = Dictionary(grouping: summary.allItems.filter { $0.title == ReloSealedCards.unreadableTitle }, by: { $0.status ?? "none" })
            .map { "\($0.key)=\($0.value.count)" }.sorted().joined(separator: ", ")
        if !reasons.isEmpty {
            let closed = { (items: [NowItem]) in items.filter { $0.title == ReloSealedCards.unreadableTitle }.count }
            Self.log.notice("now: unreadable reasons: \(reasons, privacy: .public); running=\(closed(summary.running)) needsYou=\(closed(summary.needsYou)) recent=\(closed(summary.recent)) quiet=\(closed(summary.quiet))")
        }
        setIfChanged(\.summary, summary)
        if stagedOnboarding == nil { setIfChanged(\.presentation, built ?? NotchPresentation(summary: summary, plans: plans, spoken: spokenLines)) }
        heardFromServer()
        let open = Set(summary.needsYou.compactMap { $0.question?.standing == .pending ? $0.notificationId : nil })
        setIfChanged(\.questions, questions.filter { open.contains($0.key) })
        setIfChanged(\.answers, answers.filter { open.contains($0.key) || $0.value == .accepted })
        loadOpenQuestions(summary)
    }

    /// Starts loading every pending question not yet loaded (also the retry for one that failed, on a skipped read).
    private func loadOpenQuestions(_ summary: NowSummary) {
        let open = Set(summary.needsYou.compactMap { $0.question?.standing == .pending ? $0.notificationId : nil })
        for notificationID in open where questions[notificationID] == nil && questionLoads[notificationID] == nil {
            questionLoads[notificationID] = Task { [weak self] in
                await self?.loadQuestion(notificationID: notificationID)
                self?.questionLoads[notificationID] = nil
            }
        }
    }

    /// Assigns a published property only when its value differs, so a refresh that changed nothing repaints nothing.
    private func setIfChanged<V: Equatable>(_ path: ReferenceWritableKeyPath<ReloNotchStore, V>, _ value: V) {
        if self[keyPath: path] != value { self[keyPath: path] = value }
    }

    /// A read of the server succeeded: the precise time moves, the published one only when its minute changes.
    private func heardFromServer(now: Date = Date()) {
        lastHeard = now
        guard let published = lastUpdated, Int(published.timeIntervalSinceReferenceDate / 60) == Int(now.timeIntervalSinceReferenceDate / 60) else {
            lastUpdated = now
            return
        }
    }

    /// The published time catches up with the precise one (the connection changed, so the exact time matters).
    private func publishHeard() {
        if lastUpdated != lastHeard { lastUpdated = lastHeard }
    }

    /// What each card says aloud (ADR 0015): its gist and spoken name, from the card's own text opened on this Mac.
    nonisolated static func spokenLines(_ summary: NowSummary, open: ReloSealedOpener) -> [String: SpokenText] {
        var lines: [String: SpokenText] = [:]
        let present = { (text: String?) in text.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 } }
        for item in summary.allItems {
            guard let envelope = item.sealed?.card, let data = open(envelope, item.id),
                  let text = try? JSONDecoder().decode(ReloSealedCardText.self, from: data) else { continue }
            let spoken = SpokenText(gist: present(text.spoken), name: present(text.name), voice: SpokenLine.Detail(name: text.voice))
            if spoken.gist != nil || spoken.name != nil || spoken.voice != nil { lines[item.id] = spoken }
        }
        return lines
    }

    /// Each card's plan as rounds and nested steps: the server's states and structure, labels opened from the card's
    /// sealed text on this Mac (a readable work's come from the server).
    nonisolated static func planOutlines(_ summary: NowSummary, open: ReloSealedOpener) -> [String: PlanOutline] {
        var plans: [String: PlanOutline] = [:]
        for item in summary.allItems {
            let text = item.sealed?.card.flatMap { open($0, item.id) }
                .flatMap { try? JSONDecoder().decode(ReloSealedCardText.self, from: $0) }
            if let outline = PlanOutline.make(plan: item.plan, rounds: item.rounds, text: text) { plans[item.id] = outline }
        }
        return plans
    }

    func credentialRefused() {
        feedTask?.cancel(); feedTask = nil
        clearScreen()
        connection = .needsSignIn
        problem = isLocal ? LocalMode.needsRepair : "The server signed this Mac out. Sign in again."
    }

    /// Everything the screen shows from a server's Now, forgotten: the closed wings and Home never keep the old Now.
    /// Sign-out and a refused credential share it; `resetGeneration` tells the notch's moments to forget the previous
    /// state too (so the next live Now is not replayed as a burst of changes).
    private func clearScreen() {
        nowWork?.cancel()
        screenEpoch += 1
        resetGeneration += 1
        for load in questionLoads.values { load.cancel() }
        questionLoads = [:]
        cacheExpiry?.cancel(); cacheExpiry = nil
        summary = nil
        if stagedOnboarding == nil { presentation = .empty }
        plans = [:]
        spokenLines = [:]
        questions = [:]
        answers = [:]
        waitingComputers = []
        listedComputers = []
        notices = []
        lastUpdated = nil
        lastHeard = nil
        lastAppliedData = nil
        lastNowIDs = []
        showingCached = false
        lastCachedData = nil
        nowCache.clear()
        trustedCount = -1
        problem = nil
    }

    // MARK: Since you looked

    private var lookedKey: String? {
        guard let credential, let origin = credentialOrigin else { return nil }
        return "now.lastLookedAt|\(origin.absoluteString)|\(credential.accountId)"
    }

    /// The Relo tab came on screen: read Now relative to the last look.
    public func relotabAppeared() {
        visibleSince = Date()
        if since == nil, let key = lookedKey { since = UserDefaults.standard.object(forKey: key) as? Date }
        refreshNow()
    }

    /// Tests only: a signed-in identity without the Keychain or a server.
    func adoptCredentialForTesting(_ credential: DeviceCredential, origin: URL) {
        self.credential = credential
        credentialOrigin = origin
    }

    /// Home (or any surface of Relo for Mac) is on screen and the owner looks: counts at once as a look, like the notch
    /// tab staying up for 2 s. The next read starts from now.
    public func markLooked() {
        guard let key = lookedKey else { return }
        let now = Date()
        UserDefaults.standard.set(now, forKey: key)
        since = now
    }

    /// The Relo tab left the screen: the owner looked if it was up for 2 s or more. The next look
    /// starts from now.
    public func relotabDisappeared() {
        defer { visibleSince = nil }
        guard let shown = visibleSince, Date().timeIntervalSince(shown) >= 2, let key = lookedKey else { return }
        let now = Date()
        UserDefaults.standard.set(now, forKey: key)
        since = now
    }

    /// The Dashboard on the owner's server, for what the notch cannot do (text replies, history).
    public var dashboardURL: URL? { (credentialOrigin ?? serverOrigin)?.appendingPathComponent("dashboard") }

    /// The Dashboard's security page, where encryption can be turned off.
    public var securityURL: URL? {
        guard let origin = credentialOrigin ?? serverOrigin else { return nil }
        var parts = URLComponents(url: origin.appendingPathComponent("dashboard/account"), resolvingAgainstBaseURL: false)
        parts?.fragment = "security"
        return parts?.url
    }

    // MARK: Encryption (a remote server only)

    private func authorized(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest? {
        guard let credential, let origin = credentialOrigin else { return nil }
        var request = URLRequest(url: origin.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 10
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    /// Reads the server's encryption choice and whether an iPhone is trusted (Settings, remote only).
    public func refreshEncryption() async {
        guard !isLocal, let policy = authorized("api/end-to-end/policy"),
              let (data, response) = try? await URLSession.shared.data(for: policy),
              (response as? HTTPURLResponse)?.statusCode == 200, let parsed = EncryptionPolicy.parse(data) else { return }
        encryption = parsed
        if let devices = authorized("api/devices/self/devices"),
           let (list, answer) = try? await URLSession.shared.data(for: devices), (answer as? HTTPURLResponse)?.statusCode == 200 {
            phoneTrusted = EncryptionPolicy.phoneTrusted(inDevices: list)
        }
    }

    /// Picks Always (`true`) or Automatic (`false`); the words of what went wrong, or nil. Off is the Dashboard's.
    public func setEncryption(always: Bool) async -> String? {
        guard !isLocal, let request = authorized("api/end-to-end/policy", method: "PUT", body: EncryptionPolicy.body(always: always)) else {
            return "Sign in first."
        }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200, let parsed = EncryptionPolicy.parse(data) else {
            return "Relo could not change that. Try again."
        }
        encryption = parsed
        return nil
    }

    // MARK: Notices (when no iPhone gets the push)

    /// Reads whether an iPhone receives pushes (remote only; at most every two minutes, and the last answer stands
    /// when the read fails).
    private func refreshPhonePresence(origin: URL, credential: DeviceCredential) async {
        guard !isLocal else { return }
        if let checked = phoneCheckedAt, Date().timeIntervalSince(checked) < 120 { return }
        guard var request = authorized("api/devices/self/devices") else { return }
        request.timeoutInterval = 10
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { return }
        phoneCheckedAt = Date()
        phoneReceivesPushes = MacNotices.phoneReceivesPushes(inDevices: data)
    }

    /// With no iPhone, the server's current inbox is where a plain notice lives (Now holds cards and questions): the
    /// new ones become a short moment in the notch and every current one sits in the Recent list. Questions are Now's.
    private func readNotices(origin: URL, credential: DeviceCredential, nowIDs: Set<String>) async {
        await refreshPhonePresence(origin: origin, credential: credential)
        guard showsNotices else {
            if !notices.isEmpty { notices = [] }
            return
        }
        let source = HTTPCurrentStateSource(baseURL: origin, token: credential.accessToken, nameResolver: sealed.content.nameResolver,
                                            sealedOpener: sealed.content.opener)
        guard let page = try? await source.fetchCurrentPage(after: nil), self.credential == credential else { return }
        let found = MacNotices.notices(from: page.items, excluding: nowIDs)
        let fresh = MacNotices.fresh(found, seen: &seenNotices, now: page.serverTime)
        if !fresh.isEmpty { seenNotices.save() }
        setIfChanged(\.notices, found)
        if !fresh.isEmpty { noticeArrivals = NoticeArrivals(serial: noticeArrivals.serial + 1, notices: fresh) }
        Self.log.notice("notices: current=\(found.count) new=\(fresh.count)")
    }

    // MARK: Questions and answers

    private func loadQuestion(notificationID: String) async {
        guard let credential, let origin = credentialOrigin else { return }
        let inbox = HTTPInboxDataSource(baseURL: origin, token: credential.accessToken, sealedOpener: sealed.content.opener,
                                        nameResolver: sealed.content.nameResolver, sealedDiagnoser: sealed.content.diagnoser)
        let epoch = screenEpoch
        guard let detail = try? await inbox.fetchDetail(notificationID: notificationID), epoch == screenEpoch,
              !Task.isCancelled, let interaction = detail.item.interaction, interaction.state == .pending else { return }
        let readable = QuestionReadability.isReadable(prompt: interaction.prompt)
        questions[notificationID] = Question(
            prompt: readable ? interaction.prompt : "", kind: interaction.kind,
            options: readable ? interaction.options ?? [] : [], expiresAt: interaction.expiresAt, isReadable: readable
        )
    }

    /// Sends one answer, signed with this Mac's identity key and bound to the sealed question it opened.
    public func answer(notificationID: String, action: NotificationInteractionAction, optionID: String? = nil) async {
        guard let credential, let origin = credentialOrigin, answers[notificationID] != .sending else { return }
        answers[notificationID] = .sending
        let epoch = screenEpoch
        let inbox = HTTPInboxDataSource(baseURL: origin, token: credential.accessToken, sealedOpener: sealed.content.opener,
                                        nameResolver: sealed.content.nameResolver, sealedDiagnoser: sealed.content.diagnoser)
        do {
            let detail = try await inbox.fetchDetail(notificationID: notificationID)
            guard epoch == screenEpoch else { return }
            guard let interaction = detail.item.interaction, interaction.state == .pending, interaction.expiresAt > Date() else {
                answers[notificationID] = .failed("Already answered or expired")
                await fetch()
                return
            }
            guard QuestionReadability.isReadable(prompt: interaction.prompt) else {
                answers[notificationID] = .failed(QuestionReadability.line)
                return
            }
            guard NotificationResponsePolicy.supports(action, kind: interaction.kind),
                  action != .choose || interaction.option(id: optionID) != nil else {
                answers[notificationID] = .failed("That answer does not fit this question")
                return
            }
            let value = action == .choose ? optionID.map { ["optionId": $0] } ?? [:] : [:]
            let unsigned = PendingNotificationResponse(
                accountID: credential.accountId,
                deviceID: credential.deviceId,
                notificationID: notificationID,
                action: action,
                value: value,
                idempotencyKey: "mac:\(credential.installationId.uuidString.lowercased()):\(notificationID):\(action.rawValue)"
                    + (optionID.map { ":\($0)" } ?? ""),
                expiresAt: interaction.expiresAt,
                interactionID: interaction.id,
                serverOrigin: origin
            )
            let placeholders: Set<String> = ["Private notification", ReloSealedCards.promptPlaceholder, "Encrypted question"]
            let context: String? = {
                guard let sealedNotice = detail.item.sealed, sealedNotice.content.kind == "question",
                      !placeholders.contains(interaction.prompt) else { return nil }
                return sealedNotice.content.context
            }()
            let signed = ReloAnswerSigning.sign(unsigned, signer: sealed.ring.existingIdentitySigner(), question: context)
            _ = try await HTTPMobileAPIClient(baseURL: origin).submitDecision(credential: credential, response: signed)
            guard epoch == screenEpoch else { return }
            answers[notificationID] = .accepted
            await fetch()
        } catch {
            guard epoch == screenEpoch else { return }
            answers[notificationID] = .failed(Self.message(for: error, local: isLocal, fallback: "Relo couldn't send that answer. Try again."))
        }
    }

    /// Plain words for a failure; the details go to the log, never to the screen. `fallback` is what an error with no
    /// better sentence says (what Relo was doing).
    static func message(for error: Error, local: Bool = false, fallback: String? = nil) -> String {
        log.error("failure shown in words: \(String(describing: error), privacy: .public)")
        let reach = "Relo can't reach your server. Check your connection and try again."
        let unknown = fallback ?? (local ? "Relo couldn't do that on this Mac. Try again."
                                         : "Relo couldn't sign in. Try again, or try it on this Mac.")
        if error is URLError { return local ? LocalMode.notAnswering : reach }
        if local {
            switch error {
            case MobileAPIError.serverUnreachable, InboxRemoteError.serverUnreachable: return LocalMode.notAnswering
            case MobileAPIError.reauthenticationRequired, MobileAPIError.invalidCredentials: return LocalMode.needsRepair
            case MobileAPIError.decisionRejected(let rejection): return rejection.message
            default: return unknown
            }
        }
        return switch error {
        case BrowserSignInSession.Failure.unavailable: "The sign-in window could not open."
        case MobileAPIError.serverUnreachable, InboxRemoteError.serverUnreachable: reach
        case MobileAPIError.reauthenticationRequired, MobileAPIError.invalidCredentials: "Sign in again."
        case MobileAPIError.accountDisabled: "This account is disabled."
        case MobileAPIError.decisionRejected(let rejection): rejection.message
        case CredentialStoreError.keychain: "Relo couldn't save its sign-in on this Mac. Try again."
        default: unknown
        }
    }

    /// The server this Mac's device credential belongs to and its token, for the one request Settings makes as this
    /// device (a computer invite). Nil when signed out; the token never goes anywhere but that origin.
    public var deviceAccess: (origin: URL, token: String)? {
        guard let credential, let credentialOrigin else { return nil }
        return (credentialOrigin, credential.accessToken)
    }
}
