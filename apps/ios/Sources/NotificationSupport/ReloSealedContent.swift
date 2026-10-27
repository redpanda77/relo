import CryptoKit
import Foundation
import ReloCore

/// Opens end-to-end sealed notices on this phone (docs/ENCRYPTION-PROTOCOL.md, E3.2): the push's
/// alert envelope in the Notification Service Extension, and alert and body envelopes in the app.
/// Only computers the owner verified on Settings → Devices are accepted as senders. It reads the key
/// ring and never rotates it, so the extension never races the app's key maintenance.
public struct ReloSealedContent: Sendable {
    public enum Outcome: Equatable, Sendable {
        case opened(Data)
        case unverifiedSender
        case replayed
        case unavailable
    }

    public struct Alert: Codable, Equatable, Sendable {
        public var title: String
        public var summary: String?
        public var sentAt: String?
    }

    public struct Notice: Codable, Equatable, Sendable {
        public var title: String
        public var summary: String?
        public var body: String?
        public var bodyFormat: String?
        public var imageUrl: String?
        public var destinationUrl: String?
        public var sentAt: String?
    }

    private let ring: ReloKeyRing
    private let trust: ReloTrustedClients
    private let ledger: (any ReloReplayLedger)?
    /// Where names carried by opened envelopes are remembered (E2.5).
    public let nameBook: (any ReloNameBook)?
    /// What opens share: the stores read once for a batch and the plaintext already opened.
    fileprivate let session: ReloSealedSession

    public init(ring: ReloKeyRing, trust: ReloTrustedClients, ledger: (any ReloReplayLedger)? = nil,
                nameBook: (any ReloNameBook)? = nil) {
        self.init(ring: ring, trust: trust, ledger: ledger, nameBook: nameBook, session: ReloSealedSession())
    }

    private init(ring: ReloKeyRing, trust: ReloTrustedClients, ledger: (any ReloReplayLedger)?, nameBook: (any ReloNameBook)?,
                 session: ReloSealedSession) {
        self.ring = ring
        self.trust = trust
        self.ledger = ledger
        self.nameBook = nameBook
        self.session = session
    }

    /// One session per process and kind of caller: every `live()` (rows, sync, Now, Live Activities)
    /// reads the Keychain once and opens each envelope once, instead of once per call site.
    private static let liveSessions = (app: ReloSealedSession(), widget: ReloSealedSession())

    /// `widget`: the Live Activity widget, which has no Keychain, reads the widget mirror instead.
    public static func live(bundle: Bundle = .main, widget: Bool = false) -> ReloSealedContent {
        let group = ReloKeyRing.sharedAccessGroup(bundle: bundle)
        return ReloSealedContent(ring: .live(bundle: bundle, readsMirror: widget), trust: .live(bundle: bundle, readsMirror: widget),
                                 ledger: KeychainReplayLedger(accessGroup: group),
                                 nameBook: KeychainNameBook(accessGroup: group, readsMirror: widget),
                                 session: widget ? liveSessions.widget : liveSessions.app)
    }

    /// Fills the widget mirror from the Keychain (the app at launch: an existing install has none yet).
    public func refreshWidgetMirror() {
        ReloWidgetKeyMirror.installLabelMemory()
        copyToWidgetMirror()
        Self.followGeneration(of: self)
    }

    private func copyToWidgetMirror() {
        ReloWidgetKeyMirror.shared?.refresh(ring: try? ring.store.load(), trusted: (try? trust.all()) ?? [],
                                            names: nameBook?.names() ?? [:])
    }

    /// The mirror follows every change of the keys and trust (a ring saved, a computer approved or forgotten), not
    /// only the launch copy: a widget that failed to open a card finds the keys it needs on its next try.
    private static let mirrorFollower = MirrorFollower()

    private final class MirrorFollower: @unchecked Sendable {
        private let lock = NSLock()
        private var content: ReloSealedContent?
        private var observer: NSObjectProtocol?
        private var pending = false
        private let queue = DispatchQueue(label: "relo.widget-mirror", qos: .utility)

        func follow(_ content: ReloSealedContent) {
            lock.withLock {
                self.content = content
                guard observer == nil else { return }
                observer = NotificationCenter.default.addObserver(forName: ReloE2EEGeneration.didChange, object: nil, queue: nil) { [weak self] _ in
                    self?.schedule()
                }
            }
        }

        // Changes come in bursts (a ring save and its trust): one copy after they settle.
        private func schedule() {
            let first = lock.withLock { () -> Bool in defer { pending = true }; return !pending }
            guard first else { return }
            queue.asyncAfter(deadline: .now() + 0.5) { [self] in
                let content = lock.withLock { pending = false; return self.content }
                content?.copyToWidgetMirror()
            }
        }
    }

    private static func followGeneration(of content: ReloSealedContent) { mirrorFollower.follow(content) }

    /// Replaces known handles in a server response before it is decoded.
    public var nameResolver: @Sendable (Data) -> Data {
        let book = nameBook
        return { data in book.map { ReloNames.resolve(json: data, $0.names()) } ?? data }
    }

    /// Opens `envelope` for the item `itemID` carries; a context already seen under another item is a replay.
    public func open(_ envelope: ReloEnvelope, deviceID: String, itemID: String? = nil, now: Date = Date()) -> Outcome {
        guard case let .ready(snapshot) = session.load(ring: ring, trust: trust), snapshot.trustError == nil else { return .unavailable }
        return attempt(envelope, deviceID: deviceID, itemID: itemID, now: now, snapshot: snapshot).outcome
    }

    struct Attempt {
        var outcome: Outcome
        /// Why `.unavailable` (the error, or the unsupported kind); key ids and reasons only, never text.
        var detail: String?
        var data: Data?
    }

    /// The open itself against a loaded snapshot. A success is remembered, so the same envelope opens
    /// once per process; a failure is remembered briefly, so a burst does not retry it hundreds of times.
    /// The replay ledger still admits every open of a notice or question: showing the same plaintext
    /// again under the same item is fine, under another item it is the replay the ledger exists to stop.
    fileprivate func attempt(_ envelope: ReloEnvelope, deviceID: String, itemID: String?, now: Date,
                             snapshot: ReloSealedSession.Snapshot) -> Attempt {
        guard ["notice", "question", "card", "names"].contains(envelope.kind) else {
            return Attempt(outcome: .unavailable, detail: "kind \(envelope.kind)")
        }
        let key = ReloSealedSession.key(envelope, deviceID: deviceID)
        let data: Data
        let fresh: Bool
        switch session.cached(key, snapshot: snapshot) {
        case .opened(let known):
            data = known
            fresh = false
        case .failed(let outcome, let detail):
            return Attempt(outcome: outcome, detail: detail)
        case nil:
            do {
                data = try ReloE2EE.open(envelope, deviceID: deviceID, prekey: { snapshot.opener($0, factory: ring.factory) },
                                         trustedSenders: snapshot.senders)
            } catch ReloE2EEError.untrustedSender {
                session.remember(key, .failed(.unverifiedSender, nil), snapshot: snapshot)
                return Attempt(outcome: .unverifiedSender)
            } catch {
                let detail = String(describing: error)
                session.remember(key, .failed(.unavailable, detail), snapshot: snapshot)
                return Attempt(outcome: .unavailable, detail: detail)
            }
            session.remember(key, .opened(data), snapshot: snapshot)
            fresh = true
        }
        // Cards and session names are exempt: the server repeats them with every update or snapshot.
        if !["card", "names"].contains(envelope.kind), let itemID, let ledger,
           !ledger.admit(context: envelope.context, itemID: itemID, now: now) { return Attempt(outcome: .replayed) }
        // Names were learned the first time this envelope opened.
        if fresh {
            let carried = ReloNames.carried(in: data)
            if !carried.isEmpty { nameBook?.learn(carried, sender: envelope.sender) }
        }
        return Attempt(outcome: .opened(data), data: data)
    }

    /// The push's `relo.sealed` alert, decoded; nil when the push carries none.
    public func openAlert(userInfo: [AnyHashable: Any]) -> (title: String, body: String)? {
        guard let relo = userInfo["relo"] as? [AnyHashable: Any],
              let sealed = relo["sealed"],
              let scope = relo["receiptScope"] as? [AnyHashable: Any],
              let deviceID = scope["deviceId"] as? String,
              let data = try? JSONSerialization.data(withJSONObject: sealed),
              let envelope = try? JSONDecoder().decode(ReloEnvelope.self, from: data) else { return nil }
        switch open(envelope, deviceID: deviceID, itemID: relo["notificationId"] as? String) {
        case .opened(let plaintext):
            guard let alert = try? JSONDecoder().decode(Alert.self, from: plaintext) else { return nil }
            let names = nameBook?.names() ?? [:]
            return (ReloNames.resolve(alert.title, names), ReloNames.resolve(alert.summary ?? "", names))
        case .unverifiedSender:
            return ("Relo", "Encrypted message from a new computer. Approve it in Relo → Settings → Devices to read it.")
        case .replayed:
            return ("Relo", "A repeated encrypted message was blocked.")
        case .unavailable:
            return nil
        }
    }
}

public extension ReloSealedContent {
    /// Opens with whichever recipient entry this phone still holds a prekey for.
    func openForThisPhone(_ envelope: ReloEnvelope, itemID: String) -> Data? {
        guard case let .ready(snapshot) = session.load(ring: ring, trust: trust) else { return nil }
        let held = Set(snapshot.state.prekeys.map(\.id))
        guard let entry = envelope.recipients.first(where: { held.contains($0.prekey) }),
              case .opened(let data) = open(envelope, deviceID: entry.device, itemID: itemID) else { return nil }
        return data
    }

    var opener: ReloSealedOpener {
        let sealed = self
        return { sealed.openForThisPhone($0, itemID: $1) }
    }
}

public extension ReloSealedContent {
    /// Opens card and question text for Live Activities. Cards skip the replay ledger: the server
    /// legitimately repeats a card's latest envelope on updates it makes itself. A failed attempt is
    /// recorded with its reason in `log`, so a card left on placeholders can be explained.
    func cardOpener(log: ReloSealedOpenLog? = nil) -> @Sendable (ReloEnvelope) -> Data? {
        let sealed = self
        return { envelope in
            let attempt = sealed.openCard(envelope)
            ReloSealedCards.noteFailure(attempt.data == nil ? attempt.outcome.rawValue : nil)
            // The log file is rewritten on every record: once per distinct failure per process run is enough.
            if attempt.data == nil, ReloSealedFailureLog.firstTime(context: envelope.context, outcome: attempt.outcome) {
                log?.record(.init(at: Date(), kind: envelope.kind, sender: envelope.sender, context: envelope.context,
                                  outcome: attempt.outcome, detail: attempt.detail))
            }
            return attempt.data
        }
    }

    var cardOpener: @Sendable (ReloEnvelope) -> Data? { cardOpener() }

    /// One card open with the reason it failed: key ids and outcomes only, never text or keys.
    func openCard(_ envelope: ReloEnvelope) -> (data: Data?, outcome: ReloSealedOpenRecord.Outcome, detail: String?) {
        let snapshot: ReloSealedSession.Snapshot, entry: ReloEnvelope.Recipient
        switch precheck(envelope) {
        case let .refused(outcome, detail): return (nil, outcome, detail)
        case let .ready(readySnapshot, readyEntry): (snapshot, entry) = (readySnapshot, readyEntry)
        }
        let result = attempt(envelope, deviceID: entry.device, itemID: nil, now: Date(), snapshot: snapshot)
        switch result.outcome {
        case .opened(let data):
            guard (try? JSONDecoder().decode(ReloSealedCardText.self, from: data)) != nil else {
                return (nil, .unreadableText, nil)
            }
            return (data, .opened, nil)
        case .unverifiedSender: return (nil, .computerUnknown, "sender \(envelope.sender)")
        case .replayed: return (nil, .failed, "replayed")
        case .unavailable: return (nil, .failed, result.detail)
        }
    }

    internal func ringState() throws -> ReloKeyRingState? { try ring.store.load() }

    private enum Precheck {
        case ready(ReloSealedSession.Snapshot, ReloEnvelope.Recipient)
        case refused(ReloSealedOpenRecord.Outcome, String?)
    }

    /// Everything an open needs short of decrypting: this phone's keys, a recipient entry for them,
    /// and a trusted sender. A refusal names the reason. Reads the shared snapshot, never the Keychain
    /// itself, so diagnosing a failure costs nothing.
    private func precheck(_ envelope: ReloEnvelope) -> Precheck {
        let snapshot: ReloSealedSession.Snapshot
        switch session.load(ring: ring, trust: trust) {
        case .noKeys: return .refused(.noKeys, nil)
        case .keysUnreadable(let reason): return .refused(.keysUnreadable, reason)
        case .ready(let loaded): snapshot = loaded
        }
        let held = snapshot.state.prekeys.map(\.id)
        guard let entry = envelope.recipients.first(where: { held.contains($0.prekey) }) else {
            let named = envelope.recipients.map { "\($0.device)/\($0.prekey)" }.joined(separator: ",")
            return .refused(.notForThisPhone, "sealed for \(named); this phone holds \(held.joined(separator: ","))")
        }
        if let reason = snapshot.trustError { return .refused(.trustUnreadable, reason) }
        guard snapshot.senders[envelope.sender] != nil else {
            let pinned = snapshot.trusted
            let level = pinned.first { $0.keyId == envelope.sender }?.level
            let known = pinned.map { "\($0.name)=\($0.keyId):\($0.level ?? "verified")" }.joined(separator: ",")
            return .refused(level == "pending" ? .computerPending : level == "declined" ? .computerDeclined : .computerUnknown,
                            "sender \(envelope.sender); trusted list \(known.isEmpty ? "empty" : known)")
        }
        return .ready(snapshot, entry)
    }

    /// Why this phone cannot open `envelope`, without decrypting it: the outcome's raw value, or
    /// "failed" when every precondition holds (the text itself, or a replay, kept it closed).
    var diagnoser: ReloSealedDiagnoser {
        let sealed = self
        return { envelope in
            if case let .refused(outcome, _) = sealed.precheck(envelope) { return outcome.rawValue }
            return ReloSealedOpenRecord.Outcome.failed.rawValue
        }
    }

    /// Opens a Now row's card and question for display, like a Live Activity does: no replay
    /// ledger (the server repeats a card's latest envelope on every summary).
    var displayOpener: ReloSealedOpener {
        let sealed = self
        return { envelope, _ in sealed.openCard(envelope).data }
    }
}

/// One attempt to open a sealed card on this phone. Holds key ids and outcomes, never text or keys.
public struct ReloSealedOpenRecord: Codable, Equatable, Sendable {
    public enum Outcome: String, Codable, Sendable {
        case opened
        /// The update carried no envelope for this phone: a computer did not seal it here.
        case notSealed = "not_sealed"
        /// Sealed for another phone, or for a key this phone no longer holds.
        case notForThisPhone = "not_for_this_phone"
        case computerPending = "computer_pending"
        case computerDeclined = "computer_declined"
        case computerUnknown = "computer_unknown"
        case noKeys = "no_keys"
        case keysUnreadable = "keys_unreadable"
        case trustUnreadable = "trust_unreadable"
        case unreadableText = "unreadable_text"
        case failed
    }

    public var at: Date
    public var process: String
    public var kind: String
    public var sender: String
    public var context: String
    public var outcome: Outcome
    public var detail: String?

    public init(at: Date, process: String = ReloSealedOpenRecord.currentProcess, kind: String, sender: String,
                context: String, outcome: Outcome, detail: String?) {
        self.at = at
        self.process = process
        self.kind = kind
        self.sender = sender
        self.context = context
        self.outcome = outcome
        self.detail = detail
    }

    public static var currentProcess: String {
        Bundle.main.bundleIdentifier?.split(separator: ".").last.map(String.init) ?? "unknown"
    }
}

/// The last sealed-card open attempts, in the App Group so the app can tell the owner why a card
/// stayed encrypted (Settings → Devices) and a developer can copy it off a device.
public struct ReloSealedOpenLog: Sendable {
    public static let maximum = 40
    public let url: URL

    public init(url: URL) { self.url = url }

    public static func live(bundle: Bundle = .main) -> ReloSealedOpenLog? {
        guard let group = bundle.object(forInfoDictionaryKey: "RELOAppGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return ReloSealedOpenLog(url: root.appendingPathComponent("Library/Caches/Relo/sealed-open-log.json"))
    }

    public func recent() -> [ReloSealedOpenRecord] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([ReloSealedOpenRecord].self, from: data)) ?? []
    }

    /// Best effort: a lost entry only loses a diagnostic. Repeats of the same outcome for the same
    /// card keep one entry with the latest time.
    public func record(_ record: ReloSealedOpenRecord) {
        var entries = recent()
        entries.removeAll { $0.context == record.context && $0.outcome == record.outcome && $0.process == record.process }
        entries.append(record)
        entries = Array(entries.suffix(Self.maximum))
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(entries) else { return }
        let directory = url.deletingLastPathComponent()
        #if os(iOS)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
        #endif
    }
}

/// Each distinct failed card open is logged once per process run: the log file is rewritten on every
/// record, and a snapshot of hundreds of cards would otherwise rewrite it hundreds of times.
enum ReloSealedFailureLog {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var seen = Set<String>()

    static func firstTime(context: String, outcome: ReloSealedOpenRecord.Outcome) -> Bool {
        lock.withLock {
            if seen.count >= 2_000 { seen.removeAll() }
            return seen.insert("\(context)|\(outcome.rawValue)").inserted
        }
    }
}

/// What the opens of one process share (docs/ENCRYPTION-PROTOCOL.md: nothing of this reaches disk).
///
/// A snapshot holds the key ring and trusted computers read once, the trusted senders parsed once and
/// each prekey's key-agreement key built once (a Secure Enclave key is rebuilt from its blob on every
/// use otherwise). It is reused until the process changes the keys or trust (`ReloE2EEGeneration`) or
/// 10 s pass, which bounds how long a change another process made stays unseen. Opened plaintext is
/// kept in memory only, keyed by a hash of the envelope, and dropped with the snapshot whenever the
/// keys or trust differ from what it was opened under.
final class ReloSealedSession: @unchecked Sendable {
    enum Load {
        case ready(Snapshot)
        case noKeys
        case keysUnreadable(String)
    }

    enum Remembered {
        case opened(Data)
        case failed(ReloSealedContent.Outcome, String?)
    }

    final class Snapshot: @unchecked Sendable {
        let state: ReloKeyRingState
        let trusted: [ReloTrustedClient]
        let senders: [String: Data]
        /// Set when the trusted list could not be read; such a snapshot is never reused.
        let trustError: String?
        let generation: Int
        let loadedAt: Date
        private let lock = NSLock()
        private var openers: [String: (any ReloPrekeyOpening)?] = [:]

        init(state: ReloKeyRingState, trusted: [ReloTrustedClient], trustError: String?, generation: Int, loadedAt: Date) {
            self.state = state
            self.trusted = trusted
            self.senders = ReloTrustedClients.trustedSenders(in: trusted)
            self.trustError = trustError
            self.generation = generation
            self.loadedAt = loadedAt
        }

        func opener(_ id: String, factory: any ReloKeyFactory) -> (any ReloPrekeyOpening)? {
            lock.withLock {
                if let known = openers[id] { return known }
                let made = state.prekeys.first(where: { $0.id == id }).flatMap { try? factory.opener(for: $0.key) }
                openers[id] = .some(made)
                return made
            }
        }
    }

    static let snapshotLifetime: TimeInterval = 10
    static let failureLifetime: TimeInterval = 30
    static let capacity = 512

    private let lock = NSLock()
    private var snapshot: Snapshot?
    private struct Slot {
        var value: Remembered
        var expires: Date?
        var used: Int
    }
    private var slots: [Data: Slot] = [:]
    private var tick = 0

    /// SHA-256 over what identifies one envelope for one device: the signature covers the kind,
    /// context, sender, nonce, ciphertext and every recipient entry.
    static func key(_ envelope: ReloEnvelope, deviceID: String) -> Data {
        var hasher = SHA256()
        for part in [envelope.kind, envelope.context, envelope.sender, envelope.nonce, envelope.ct, envelope.sig, deviceID] {
            hasher.update(data: Data(part.utf8))
            hasher.update(data: Data([0]))
        }
        return Data(hasher.finalize())
    }

    func load(ring: ReloKeyRing, trust: ReloTrustedClients, now: Date = Date()) -> Load {
        lock.withLock {
            let generation = ReloE2EEGeneration.current
            if let snapshot, snapshot.trustError == nil, snapshot.generation == generation,
               now.timeIntervalSince(snapshot.loadedAt) < Self.snapshotLifetime { return .ready(snapshot) }
            let state: ReloKeyRingState
            do {
                guard let loaded = try ring.store.load() else { return reset(.noKeys) }
                state = loaded
            } catch {
                return reset(.keysUnreadable(String(describing: error)))
            }
            let trusted: [ReloTrustedClient], trustError: String?
            do { (trusted, trustError) = (try trust.all(), nil) } catch { (trusted, trustError) = ([], String(describing: error)) }
            let fresh = Snapshot(state: state, trusted: trusted, trustError: trustError, generation: generation, loadedAt: now)
            if let old = snapshot, old.generation != generation || old.state != state || old.trusted != trusted { slots = [:] }
            if trustError == nil {
                snapshot = fresh
            } else {
                snapshot = nil
                slots = [:]
            }
            return .ready(fresh)
        }
    }

    private func reset(_ load: Load) -> Load {
        snapshot = nil
        slots = [:]
        return load
    }

    func cached(_ key: Data, snapshot: Snapshot, now: Date = Date()) -> Remembered? {
        lock.withLock {
            guard self.snapshot === snapshot, var slot = slots[key] else { return nil }
            if let expires = slot.expires, expires <= now {
                slots[key] = nil
                return nil
            }
            tick += 1
            slot.used = tick
            slots[key] = slot
            return slot.value
        }
    }

    func remember(_ key: Data, _ value: Remembered, snapshot: Snapshot, now: Date = Date()) {
        lock.withLock {
            // Opened under keys or trust that have since changed: not remembered.
            guard self.snapshot === snapshot, snapshot.generation == ReloE2EEGeneration.current else { return }
            tick += 1
            var expires: Date?
            if case .failed = value { expires = now.addingTimeInterval(Self.failureLifetime) }
            slots[key] = Slot(value: value, expires: expires, used: tick)
            if slots.count > Self.capacity, let oldest = slots.min(by: { $0.value.used < $1.value.used })?.key {
                slots[oldest] = nil
            }
        }
    }
}
