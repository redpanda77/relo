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

    public init(ring: ReloKeyRing, trust: ReloTrustedClients, ledger: (any ReloReplayLedger)? = nil) {
        self.ring = ring
        self.trust = trust
        self.ledger = ledger
    }

    public static func live(bundle: Bundle = .main) -> ReloSealedContent {
        ReloSealedContent(ring: .live(bundle: bundle), trust: .live(bundle: bundle),
                          ledger: KeychainReplayLedger(accessGroup: ReloKeyRing.sharedAccessGroup(bundle: bundle)))
    }

    /// Opens `envelope` for the item `itemID` carries; a context already seen under another item is a replay.
    public func open(_ envelope: ReloEnvelope, deviceID: String, itemID: String? = nil, now: Date = Date()) -> Outcome {
        guard let state = try? ring.store.load(), let senders = try? trust.trustedSenders() else { return .unavailable }
        do {
            guard ["notice", "question", "card"].contains(envelope.kind) else { return .unavailable }
            let data = try ReloE2EE.open(envelope, deviceID: deviceID, prekey: ring.prekeyOpener(state: state),
                                         trustedSenders: senders)
            if let itemID, let ledger, !ledger.admit(context: envelope.context, itemID: itemID, now: now) { return .replayed }
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
            return (alert.title, alert.summary ?? "")
        case .unverifiedSender:
            return ("Relo", "Encrypted message from a computer you have not verified. Open Settings → Security.")
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
    /// legitimately repeats a card's latest envelope on updates it makes itself.
    var cardOpener: @Sendable (ReloEnvelope) -> Data? {
        let sealed = self
        return { envelope in
            guard let state = try? sealed.ringState() else { return nil }
            let held = Set(state.prekeys.map(\.id))
            guard let entry = envelope.recipients.first(where: { held.contains($0.prekey) }),
                  case .opened(let data) = sealed.open(envelope, deviceID: entry.device) else { return nil }
            return data
        }
    }

    internal func ringState() throws -> ReloKeyRingState? { try ring.store.load() }
}
