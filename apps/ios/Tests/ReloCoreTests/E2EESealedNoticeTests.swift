import CryptoKit
import Foundation
import XCTest
@testable import ReloCore
@testable import ReloNotificationSupport

final class E2EESealedNoticeTests: XCTestCase {
    private final class RingStore: ReloKeyRingStore, @unchecked Sendable {
        private let lock = NSLock()
        private var state: ReloKeyRingState?
        func load() throws -> ReloKeyRingState? { lock.withLock { state } }
        func save(_ state: ReloKeyRingState) throws { lock.withLock { self.state = state } }
        func delete() throws { lock.withLock { state = nil } }
    }

    private final class TrustStore: ReloTrustedClientStore, @unchecked Sendable {
        private let lock = NSLock()
        private var clients: [ReloTrustedClient] = []
        func load() throws -> [ReloTrustedClient] { lock.withLock { clients } }
        func save(_ clients: [ReloTrustedClient]) throws { lock.withLock { self.clients = clients } }
    }

    private let deviceID = "dev_00000000-0000-4000-8000-000000000001"

    private func phone() throws -> (sealed: ReloSealedContent, trust: ReloTrustedClients, prekey: ReloStoredPrekey) {
        let ring = ReloKeyRing(store: RingStore(), factory: ReloSoftwareKeyFactory())
        let state = try ring.maintain()
        let trust = ReloTrustedClients(store: TrustStore())
        return (ReloSealedContent(ring: ring, trust: trust), trust, state.prekeys[0])
    }

    private func computer(_ trust: ReloTrustedClients?, verified: Bool) throws -> ReloSoftwareIdentity {
        let identity = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        let key = ReloClientKey(clientId: "key_1", name: "Mac", keyId: ReloE2EE.keyID(publicKeyX963: identity.publicKeyX963),
                                publicKey: ReloE2EE.base64URL(identity.publicKeyX963), changedAt: "")
        if verified { try trust?.markVerified(key) }
        return identity
    }

    private func notice(_ sender: ReloSoftwareIdentity, prekey: ReloStoredPrekey, content: [String: String]) throws -> ReloEnvelope {
        try ReloE2EE.seal(kind: "notice", context: "ntf:test", sender: sender,
                          recipients: [(deviceID, prekey.id, prekey.key.publicKey)],
                          content: try JSONSerialization.data(withJSONObject: content))
    }

    private func placeholder(_ sealed: InboxSealedNotice) -> InboxItem {
        InboxItem(id: "ntf_1", kind: .notification, sourceName: "Relo", title: "Encrypted notification",
                  detail: "Open Relo on your iPhone to read this.", createdAt: Date(), privacy: .private, sealed: sealed)
    }

    func testInboxItemsOpenOnlyFromVerifiedComputers() throws {
        let (sealed, trust, prekey) = try phone()
        let verified = try computer(trust, verified: true)
        let content = try notice(verified, prekey: prekey, content: [
            "title": "Deploy finished", "summary": "All green", "body": "## Details\nsecret", "bodyFormat": "markdown",
        ])
        let opened = placeholder(InboxSealedNotice(alert: nil, content: content)).openingSealed(sealed.opener)
        XCTAssertEqual(opened.title, "Deploy finished")
        XCTAssertEqual(opened.content?.body, "## Details\nsecret")
        XCTAssertEqual(opened.content?.format, .markdown)
        XCTAssertEqual(opened.privacy, .standard)
        XCTAssertTrue(opened.isEndToEndEncrypted)

        let stranger = try computer(nil, verified: false)
        let forged = placeholder(InboxSealedNotice(alert: nil, content: try notice(stranger, prekey: prekey, content: ["title": "Approve the transfer"])))
        let locked = forged.openingSealed(sealed.opener, diagnose: sealed.diagnoser)
        XCTAssertEqual(locked.title, "Encrypted notification", "an unverified sender leaves the placeholder")
        XCTAssertNil(locked.content)
        XCTAssertEqual(locked.unreadableLine, "It comes from a computer you haven't approved, so this iPhone won't open it.")
    }

    func testPushAlertOpensInTheExtensionAndFlagsUnverifiedSenders() throws {
        let (sealed, trust, prekey) = try phone()
        let verified = try computer(trust, verified: true)
        let alert = try notice(verified, prekey: prekey, content: ["title": "Deployed", "summary": "0.10.1 is live"])
        let userInfo: [AnyHashable: Any] = ["relo": [
            "privacy": "private", "receiptScope": ["deviceId": deviceID],
            "sealed": try JSONSerialization.jsonObject(with: JSONEncoder().encode(alert)),
        ]]
        let opened = try XCTUnwrap(sealed.openAlert(userInfo: userInfo))
        XCTAssertEqual(opened.title, "Deployed")
        XCTAssertEqual(opened.body, "0.10.1 is live")

        let stranger = try notice(try computer(nil, verified: false), prekey: prekey, content: ["title": "Fake"])
        let strangerInfo: [AnyHashable: Any] = ["relo": [
            "receiptScope": ["deviceId": deviceID], "sealed": try JSONSerialization.jsonObject(with: JSONEncoder().encode(stranger)),
        ]]
        XCTAssertEqual(sealed.openAlert(userInfo: strangerInfo)?.title, "Relo")
        XCTAssertNil(sealed.openAlert(userInfo: ["relo": ["privacy": "standard"]]), "plain pushes are left alone")
    }

    func testDecodesTheServerSealedFieldAndKeepsItInTheCache() throws {
        let (_, trust, prekey) = try phone()
        let envelope = try notice(try computer(trust, verified: true), prekey: prekey, content: ["title": "x"])
        let json = """
        {"id":"ntf_1","kind":"notification","sourceName":"Relo","title":"Encrypted notification","createdAt":"2026-10-13T17:00:00Z",
         "privacy":"private","sealed":{"alert":null,"content":\(String(decoding: try JSONEncoder().encode(envelope), as: UTF8.self))}}
        """
        let item = try ReloWireJSON.decoder().decode(InboxItem.self, from: Data(json.utf8))
        XCTAssertEqual(item.sealed?.content, envelope)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let roundTrip = try ReloWireJSON.decoder().decode(InboxItem.self, from: try encoder.encode(item))
        XCTAssertEqual(roundTrip.sealed, item.sealed)
    }

    func testSealedQuestionsOpenWithTheirRealPrompt() throws {
        let (sealed, trust, prekey) = try phone()
        let mac = try computer(trust, verified: true)
        let question = try ReloE2EE.seal(kind: "question", context: "ntf:q", sender: mac,
                                         recipients: [(deviceID, prekey.id, prekey.key.publicKey)],
                                         content: try JSONSerialization.data(withJSONObject: ["title": "Release", "summary": "Deploy now?", "body": "Deploy now?"]))
        let item = InboxItem(id: "ntf_q", kind: .notification, sourceName: "Relo", title: "Encrypted question", createdAt: Date(),
                             privacy: .private,
                             interaction: InboxInteraction(id: "int_q", kind: .approval, prompt: "Open Relo on your iPhone to read this question.",
                                                           state: .pending, expiresAt: Date().addingTimeInterval(60), respondedAt: nil),
                             sealed: InboxSealedNotice(alert: nil, content: question))
        let opened = item.openingSealed(sealed.opener)
        XCTAssertEqual(opened.title, "Release")
        XCTAssertEqual(opened.interaction?.prompt, "Deploy now?")
        XCTAssertEqual(opened.interaction?.id, "int_q")
    }

    private final class MemoryLedger: ReloReplayLedger, @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [String: ReloReplayEntry] = [:]
        func admit(context: String, itemID: String, now: Date) -> Bool {
            lock.withLock { ReloReplayRules.admit(&entries, context: context, itemID: itemID, now: now) }
        }
    }

    func testAReplayedEnvelopeUnderANewItemIsBlockedButRefetchingTheSameItemIsNot() throws {
        let ring = ReloKeyRing(store: RingStore(), factory: ReloSoftwareKeyFactory())
        let state = try ring.maintain()
        let trust = ReloTrustedClients(store: TrustStore())
        let sealed = ReloSealedContent(ring: ring, trust: trust, ledger: MemoryLedger())
        let envelope = try notice(try computer(trust, verified: true), prekey: state.prekeys[0], content: ["title": "Deploy succeeded"])
        let original = placeholder(InboxSealedNotice(alert: nil, content: envelope))
        XCTAssertEqual(original.openingSealed(sealed.opener).title, "Deploy succeeded")
        XCTAssertEqual(original.openingSealed(sealed.opener).title, "Deploy succeeded", "refetching the same item is fine")
        let replay = InboxItem(id: "ntf_replayed", kind: .notification, sourceName: "Relo", title: "Encrypted notification",
                               createdAt: Date(), privacy: .private, sealed: InboxSealedNotice(alert: nil, content: envelope))
        XCTAssertEqual(replay.openingSealed(sealed.opener).title, "Encrypted notification", "a replay stays locked")

        let push: [AnyHashable: Any] = ["relo": ["notificationId": "ntf_push_replay", "receiptScope": ["deviceId": deviceID],
                                                 "sealed": try JSONSerialization.jsonObject(with: JSONEncoder().encode(envelope))]]
        XCTAssertEqual(sealed.openAlert(userInfo: push)?.body, "A repeated encrypted message was blocked.")
    }

    func testTheLedgerForgetsOldestContextsBeyondItsCapacity() {
        var entries: [String: ReloReplayEntry] = [:]
        let start = Date(timeIntervalSince1970: 0)
        for index in 0...ReloReplayRules.capacity {
            XCTAssertTrue(ReloReplayRules.admit(&entries, context: "c\(index)", itemID: "i\(index)", now: start.addingTimeInterval(Double(index))))
        }
        XCTAssertEqual(entries.count, ReloReplayRules.capacity)
        XCTAssertNil(entries["c0"])
        XCTAssertFalse(ReloReplayRules.admit(&entries, context: "c5", itemID: "other", now: start))
    }

    /// The activity detail screen reads the card summary, not the row title: it must open too.
    func testCardDetailSummaryShowsTheOpenedTitleAndStatus() throws {
        let (sealed, trust, prekey) = try phone()
        let mac = try computer(trust, verified: true)
        let envelope = try ReloE2EE.seal(kind: "card", context: "ntf:card", sender: mac,
                                         recipients: [(deviceID, prekey.id, prekey.key.publicKey)],
                                         content: try JSONSerialization.data(withJSONObject: ["title": "Device trust release", "status": "Shipping"]))
        let item = InboxItem(id: "ntf_2", kind: .liveActivity, sourceName: "Claude Code", title: "Encrypted card",
                             detail: nil, createdAt: Date(), privacy: .standard,
                             activitySummary: InboxActivitySummary(id: "act_1", generation: 1, sequence: 2, state: "active",
                                                                   title: "Encrypted card", status: "Approved · Updating…"),
                             sealed: InboxSealedNotice(alert: nil, content: envelope))
        let opened = item.openingSealed(sealed.opener)
        XCTAssertEqual(opened.title, "Device trust release")
        XCTAssertEqual(opened.activitySummary?.title, "Device trust release")
        XCTAssertEqual(opened.activitySummary?.status, "Approved · Shipping", "the server's own words stay")
    }

    // MARK: Now rows (GET /api/now `sealed`)

    private func nowItem(title: String, status: String?, current: String? = nil, notificationID: String? = nil,
                         questionID: String? = nil, sealed: NowItem.Sealed?) throws -> NowItem {
        var object: [String: Any] = [
            "id": "act_00000000-0000-4000-8000-000000000001", "title": title, "status": status ?? NSNull(),
            "sourceName": "Claude Code", "project": "relo", "producer": "agent_session", "sessionId": NSNull(),
            "notificationId": notificationID ?? NSNull(),
            "startedAt": "2026-10-14T09:58:00.000Z", "declaredAt": "2026-10-14T09:58:00.000Z",
            "steps": current.map { ["done": 1, "total": 3, "current": $0] as [String: Any] } ?? NSNull(),
            "question": questionID.map { ["id": $0, "standing": "missed", "askedAt": "2026-10-14T09:58:00.000Z",
                                          "openedAt": NSNull()] as [String: Any] } ?? NSNull(),
            "owner": ["state": "moving", "needsYou": NSNull(), "evidenceAt": "2026-10-14T09:58:00.000Z",
                      "evidenceSource": "declared", "staleDate": "2026-10-14T10:18:00.000Z", "lockScreen": "shown",
                      "relevance": 0.5, "apnsPriority": 5] as [String: Any],
        ]
        if let sealed {
            object["sealed"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(sealed))
        }
        return try ReloWireJSON.decoder().decode(NowItem.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func card(_ sender: ReloSoftwareIdentity, prekey: ReloStoredPrekey, _ content: [String: Any],
                      kind: String = "card") throws -> ReloEnvelope {
        try ReloE2EE.seal(kind: kind, context: "act:\(kind)", sender: sender,
                          recipients: [(deviceID, prekey.id, prekey.key.publicKey)],
                          content: try JSONSerialization.data(withJSONObject: content))
    }

    func testNowRowsOpenTheirSealedCardAndReplaceOnlyPlaceholders() throws {
        let (sealed, trust, prekey) = try phone()
        let mac = try computer(trust, verified: true)
        let envelope = try card(mac, prekey: prekey, ["title": "Ship the release", "status": "Running local gates",
                                                      "steps": ["Build", "Run local gates", "Deploy"]])
        let item = try nowItem(title: "Encrypted card", status: "Approved · Updating…", current: "Step 2",
                               sealed: .init(card: envelope))
        var summary = try XCTUnwrap(Self.summary())
        summary.running = [item]
        let opened = summary.openingSealed(sealed.displayOpener, diagnose: sealed.diagnoser).running[0]
        XCTAssertEqual(opened.title, "Ship the release")
        XCTAssertEqual(opened.status, "Approved · Running local gates", "the server's own words stay")
        XCTAssertEqual(opened.steps?.current, "Run local gates")

        // Words the server wrote itself are never replaced, even when the card opens.
        let plain = try nowItem(title: "Deploy the site", status: "Approved", sealed: .init(card: envelope))
        let kept = plain.openingSealed(sealed.displayOpener, diagnose: sealed.diagnoser)
        XCTAssertEqual(kept.title, "Deploy the site")
        XCTAssertEqual(kept.status, "Approved")
    }

    func testNowQuestionRowsOpenTheirPrompt() throws {
        let (sealed, trust, prekey) = try phone()
        let mac = try computer(trust, verified: true)
        let question = try card(mac, prekey: prekey, ["title": "Release", "summary": "Deploy to production?"], kind: "question")
        let item = try nowItem(title: "Encrypted question", status: ReloSealedCards.promptPlaceholder,
                               notificationID: "ntf_00000000-0000-4000-8000-000000000009",
                               questionID: "int_00000000-0000-4000-8000-000000000009", sealed: .init(question: question))
        let opened = item.openingSealed(sealed.displayOpener, diagnose: sealed.diagnoser)
        XCTAssertEqual(opened.title, "Release")
        XCTAssertEqual(opened.status, "Deploy to production?")
    }

    func testNowRowsThisPhoneCannotOpenSayWhyInsteadOfEncryptedCard() throws {
        let (sealed, trust, _) = try phone()
        let mac = try computer(trust, verified: true)
        // Sealed for another phone's key.
        let (_, _, otherPrekey) = try phone()
        let elsewhere = try card(mac, prekey: otherPrekey, ["title": "Secret", "status": "Hidden"])
        let item = try nowItem(title: "Encrypted card", status: "Updating…", current: "Step 1", sealed: .init(card: elsewhere))
        let locked = item.openingSealed(sealed.displayOpener, diagnose: sealed.diagnoser)
        XCTAssertEqual(locked.title, "Can't be read on this iPhone")
        XCTAssertEqual(locked.status, "Sealed for another device")
        XCTAssertNil(locked.steps?.current, "a \"Step n\" placeholder tells the owner nothing")
        XCTAssertEqual(locked.steps?.total, 3)

        // From a computer this phone has not approved.
        let stranger = try computer(nil, verified: false)
        let (mine, _, myPrekey) = try phone()
        let unapproved = try card(stranger, prekey: myPrekey, ["title": "Approve the transfer"])
        let strangerRow = try nowItem(title: "Encrypted card", status: nil, sealed: .init(card: unapproved))
            .openingSealed(mine.displayOpener, diagnose: mine.diagnoser)
        XCTAssertEqual(strangerRow.title, "Can't be read on this iPhone")
        XCTAssertEqual(strangerRow.status, "From a computer you haven't approved")

        // No envelope for this phone at all.
        let bare = try nowItem(title: "Encrypted card", status: "Updating…", sealed: nil)
            .openingSealed(sealed.displayOpener, diagnose: sealed.diagnoser)
        XCTAssertEqual(bare.title, "Can't be read on this iPhone")
        XCTAssertEqual(bare.status, "Not sealed for this iPhone")
    }

    func testALockedQuestionDetailSaysWhyThisIPhoneCannotReadIt() throws {
        let (sealed, trust, _) = try phone()
        let (_, _, otherPrekey) = try phone()
        let mac = try computer(trust, verified: true)
        let question = try ReloE2EE.seal(kind: "question", context: "ntf:elsewhere", sender: mac,
                                         recipients: [(deviceID, otherPrekey.id, otherPrekey.key.publicKey)],
                                         content: try JSONSerialization.data(withJSONObject: ["title": "Release"]))
        let item = InboxItem(id: "ntf_q2", kind: .notification, sourceName: "Relo", title: "Encrypted question", createdAt: Date(),
                             privacy: .private,
                             interaction: InboxInteraction(id: "int_q2", kind: .approval, prompt: ReloSealedCards.promptPlaceholder,
                                                           state: .pending, expiresAt: Date().addingTimeInterval(60), respondedAt: nil),
                             sealed: InboxSealedNotice(alert: nil, content: question))
        let locked = item.openingSealed(sealed.opener, diagnose: sealed.diagnoser)
        XCTAssertEqual(locked.unreadableLine, "This was sealed for another device, so this iPhone can't read it.")
        XCTAssertEqual(locked.interaction?.prompt, ReloSealedCards.promptPlaceholder, "an unopened prompt is never signed")
    }

    private static func summary() -> NowSummary? {
        let json = """
        {"serverTime":"2026-10-14T10:00:00Z",
         "sinceYouLooked":{"since":"2026-10-14T09:00:00Z","finished":0,"failed":0,"waitingOnYou":0,"stoppedWithoutFinishing":0,"needsYou":0},
         "needsYou":[],"recent":[],"waitingOnYou":[],"quiet":[],"paused":[],"running":[],
         "folds":{"waitingOnYou":0,"quiet":0,"paused":0},"lockScreen":{"cards":[],"needsYouCount":0,"focus":null},
         "sessions":{"sessions":[],"folds":{"idle":0}},"refreshAt":null}
        """
        return try? ReloWireJSON.decoder().decode(NowSummary.self, from: Data(json.utf8))
    }
}
