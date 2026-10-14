import Foundation
import ReloCore

/// Opens end-to-end sealed notices on this phone (docs/END-TO-END-ENCRYPTION.md, E3.2): the push's
/// alert envelope in the Notification Service Extension, and alert and body envelopes in the app.
/// Only computers the owner verified on Settings → Security are accepted as senders. It reads the key
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

    public init(ring: ReloKeyRing, trust: ReloTrustedClients, ledger: (any ReloReplayLedger)? = nil,
                nameBook: (any ReloNameBook)? = nil) {
        self.ring = ring
        self.trust = trust
        self.ledger = ledger
        self.nameBook = nameBook
    }

    /// `widget`: the Live Activity widget, which has no Keychain, reads the widget mirror instead.
    public static func live(bundle: Bundle = .main, widget: Bool = false) -> ReloSealedContent {
        let group = ReloKeyRing.sharedAccessGroup(bundle: bundle)
        return ReloSealedContent(ring: .live(bundle: bundle, readsMirror: widget), trust: .live(bundle: bundle, readsMirror: widget),
                                 ledger: KeychainReplayLedger(accessGroup: group),
                                 nameBook: KeychainNameBook(accessGroup: group, readsMirror: widget))
    }

    /// Fills the widget mirror from the Keychain (the app at launch: an existing install has none yet).
    public func refreshWidgetMirror() {
        ReloWidgetKeyMirror.shared?.refresh(ring: try? ring.store.load(), trusted: (try? trust.all()) ?? [],
                                            names: nameBook?.names() ?? [:])
    }

    /// Replaces known handles in a server response before it is decoded.
    public var nameResolver: @Sendable (Data) -> Data {
        let book = nameBook
        return { data in book.map { ReloNames.resolve(json: data, $0.names()) } ?? data }
    }

    /// Opens `envelope` for the item `itemID` carries; a context already seen under another item is a replay.
    public func open(_ envelope: ReloEnvelope, deviceID: String, itemID: String? = nil, now: Date = Date()) -> Outcome {
        guard let state = try? ring.store.load(), let senders = try? trust.trustedSenders() else { return .unavailable }
        do {
            guard ["notice", "question", "card", "names"].contains(envelope.kind) else { return .unavailable }
            let data = try ReloE2EE.open(envelope, deviceID: deviceID, prekey: ring.prekeyOpener(state: state),
                                         trustedSenders: senders)
            // Cards and session names are exempt: the server repeats them with every update or snapshot.
            if !["card", "names"].contains(envelope.kind), let itemID, let ledger,
               !ledger.admit(context: envelope.context, itemID: itemID, now: now) { return .replayed }
            let carried = ReloNames.carried(in: data)
            if !carried.isEmpty { nameBook?.learn(carried, sender: envelope.sender) }
            return .opened(data)
        } catch ReloE2EEError.untrustedSender {
            return .unverifiedSender
        } catch {
            return .unavailable
        }
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
            return ("Relo", "Encrypted message from a new computer. Approve it in Relo → Settings → Security to read it.")
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
        guard let state = try? ring.store.load() else { return nil }
        let held = Set(state.prekeys.map(\.id))
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
            if attempt.data == nil {
                log?.record(.init(at: Date(), kind: envelope.kind, sender: envelope.sender, context: envelope.context,
                                  outcome: attempt.outcome, detail: attempt.detail))
            }
            return attempt.data
        }
    }

    var cardOpener: @Sendable (ReloEnvelope) -> Data? { cardOpener() }

    /// One card open with the reason it failed: key ids and outcomes only, never text or keys.
    func openCard(_ envelope: ReloEnvelope) -> (data: Data?, outcome: ReloSealedOpenRecord.Outcome, detail: String?) {
        let state: ReloKeyRingState, entry: ReloEnvelope.Recipient, senders: [String: Data]
        switch precheck(envelope) {
        case let .refused(outcome, detail): return (nil, outcome, detail)
        case let .ready(ready): (state, entry, senders) = ready
        }
        switch open(envelope, deviceID: entry.device) {
        case .opened(let data):
            guard (try? JSONDecoder().decode(ReloSealedCardText.self, from: data)) != nil else {
                return (nil, .unreadableText, nil)
            }
            return (data, .opened, nil)
        case .unverifiedSender: return (nil, .computerUnknown, "sender \(envelope.sender)")
        case .replayed: return (nil, .failed, "replayed")
        case .unavailable:
            do {
                _ = try ReloE2EE.open(envelope, deviceID: entry.device, prekey: ring.prekeyOpener(state: state),
                                      trustedSenders: senders)
                return (nil, .failed, "kind \(envelope.kind)")
            } catch {
                return (nil, .failed, String(describing: error))
            }
        }
    }

    internal func ringState() throws -> ReloKeyRingState? { try ring.store.load() }

    private enum Precheck {
        case ready(ReloKeyRingState, ReloEnvelope.Recipient, [String: Data])
        case refused(ReloSealedOpenRecord.Outcome, String?)
    }

    /// Everything an open needs short of decrypting: this phone's keys, a recipient entry for them,
    /// and a trusted sender. A refusal names the reason.
    private func precheck(_ envelope: ReloEnvelope) -> Precheck {
        let state: ReloKeyRingState
        do {
            guard let loaded = try ring.store.load() else { return .refused(.noKeys, nil) }
            state = loaded
        } catch {
            return .refused(.keysUnreadable, String(describing: error))
        }
        let held = state.prekeys.map(\.id)
        guard let entry = envelope.recipients.first(where: { held.contains($0.prekey) }) else {
            let named = envelope.recipients.map { "\($0.device)/\($0.prekey)" }.joined(separator: ",")
            return .refused(.notForThisPhone, "sealed for \(named); this phone holds \(held.joined(separator: ","))")
        }
        let senders: [String: Data]
        do { senders = try trust.trustedSenders() } catch {
            return .refused(.trustUnreadable, String(describing: error))
        }
        guard senders[envelope.sender] != nil else {
            let pinned = (try? trust.all()) ?? []
            let level = pinned.first { $0.keyId == envelope.sender }?.level
            let known = pinned.map { "\($0.name)=\($0.keyId):\($0.level ?? "verified")" }.joined(separator: ",")
            return .refused(level == "pending" ? .computerPending : level == "declined" ? .computerDeclined : .computerUnknown,
                            "sender \(envelope.sender); trusted list \(known.isEmpty ? "empty" : known)")
        }
        return .ready(state, entry, senders)
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
/// stayed encrypted (Settings → Security) and a developer can copy it off a device.
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
