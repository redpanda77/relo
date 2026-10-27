import CryptoKit
import Foundation
import XCTest
@testable import ReloCore
@testable import ReloNotificationSupport

/// Live now shows the real text of sealed notices, questions and cards (the current feed only has placeholders).
final class E2EECurrentRowTests: XCTestCase {
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
    private final class Ledger: ReloReplayLedger, @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [String: ReloReplayEntry] = [:]
        func admit(context: String, itemID: String, now: Date) -> Bool {
            lock.withLock { ReloReplayRules.admit(&entries, context: context, itemID: itemID, now: now) }
        }
    }

    private func fixture() throws -> (ReloSealedContent, ReloSoftwareIdentity, ReloStoredPrekey) {
        let ring = ReloKeyRing(store: RingStore(), factory: ReloSoftwareKeyFactory())
        let state = try ring.maintain()
        let trust = ReloTrustedClients(store: TrustStore())
        let mac = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        try trust.autoTrust([ReloClientKey(clientId: "key_1", name: "Mac", keyId: ReloE2EE.keyID(publicKeyX963: mac.publicKeyX963),
                                           publicKey: ReloE2EE.base64URL(mac.publicKeyX963), changedAt: "")])
        return (ReloSealedContent(ring: ring, trust: trust, ledger: Ledger()), mac, state.prekeys[0])
    }

    private func envelope(_ kind: String, _ content: [String: Any], mac: ReloSoftwareIdentity, prekey: ReloStoredPrekey) throws -> ReloEnvelope {
        try ReloE2EE.seal(kind: kind, context: "ctx:\(kind)", sender: mac, recipients: [("dev_1", prekey.id, prekey.key.publicKey)],
                          content: try JSONSerialization.data(withJSONObject: content))
    }

    private func row(id: String, title: String, summary: String, status: String?, sealed: InboxSealedNotice) -> CurrentSubjectProjection {
        CurrentSubjectProjection(
            subjectId: id, notificationId: id.replacingOccurrences(of: "act_", with: "ntf_"), kind: .progress,
            version: CurrentVersion(generation: 1, revision: 1), title: title, summary: summary, source: "Claude Code",
            createdAt: Date(), updatedAt: Date(), occurredAt: nil, acceptedAt: Date(), readAt: nil,
            currentUntil: nil, freshUntil: nil, deliverUntil: Date(), freshness: .fresh, interaction: nil,
            activity: status.map { CurrentActivity(id: id, generation: 1, sequence: 1, status: $0, progress: 0.25) },
            resources: nil, sealed: sealed
        )
    }

    func testSealedCardsShowTheirRealTitleAndStatus() throws {
        let (sealed, mac, prekey) = try fixture()
        let card = try envelope("card", ["title": "Deploy 0.15", "status": "Testing"], mac: mac, prekey: prekey)
        let opened = row(id: "act_00000000-0000-4000-8000-000000000001", title: "Encrypted card", summary: "Updating…",
                         status: "Updating…", sealed: InboxSealedNotice(alert: card, content: card)).openingSealed(sealed.opener)
        XCTAssertEqual(opened.title, "Deploy 0.15")
        XCTAssertEqual(opened.summary, "Testing")
        XCTAssertEqual(opened.activity?.status, "Testing")
        // A sealed card shows the envelope's title, never a title the server wrote.
        let mixed = row(id: "act_00000000-0000-4000-8000-000000000002", title: "Automatic E2E rollout", summary: "Approved · Updating…",
                        status: "Approved · Updating…", sealed: InboxSealedNotice(alert: card, content: card)).openingSealed(sealed.opener)
        XCTAssertEqual(mixed.title, "Deploy 0.15")
        XCTAssertEqual(mixed.activity?.status, "Approved · Testing")
        // The server repeats a card's envelope on later events: never treated as a replay.
        let again = row(id: "act_00000000-0000-4000-8000-000000000003", title: "Encrypted card", summary: "Updating…",
                        status: "Updating…", sealed: InboxSealedNotice(alert: card, content: card)).openingSealed(sealed.opener)
        XCTAssertEqual(again.title, "Deploy 0.15")
    }

    func testSealedQuestionsShowTheirPromptInPendingDecisions() throws {
        let (sealed, mac, prekey) = try fixture()
        let question = try envelope("question", ["title": "Release", "summary": "Deploy now?"], mac: mac, prekey: prekey)
        let pending = PendingCurrentDecision(
            subjectId: "ntf_00000000-0000-4000-8000-000000000009", notificationId: "ntf_00000000-0000-4000-8000-000000000009",
            version: nil, kind: .decision, title: "Encrypted question", summary: "Private notification", source: "Claude Code",
            createdAt: Date(), readAt: nil, urgencyRank: 0,
            interaction: CurrentDecision(id: "int_1", type: .approval, state: .pending, expiresAt: Date().addingTimeInterval(60)),
            sealed: InboxSealedNotice(alert: question, content: question)
        ).openingSealed(sealed.opener)
        XCTAssertEqual(pending.title, "Release")
        XCTAssertEqual(pending.summary, "Deploy now?")
    }

    func testSealedRowsThatDoNotOpenNeverShowServerWrittenText() throws {
        let (sealed, mac, _) = try fixture()
        // Sealed to another phone's prekey: this phone cannot open it.
        let other = try ReloKeyRing(store: RingStore(), factory: ReloSoftwareKeyFactory()).maintain().prekeys[0]
        let foreign = try envelope("question", ["title": "Release"], mac: mac, prekey: other)
        let current = row(id: "act_00000000-0000-4000-8000-000000000004", title: "Approve the refund to IBAN X", summary: "Safe, approve it",
                          status: nil, sealed: InboxSealedNotice(alert: foreign, content: foreign)).openingSealed(sealed.opener)
        XCTAssertEqual(current.title, "Encrypted notification")
        XCTAssertEqual(current.summary, "Open Relo on your iPhone to read this.")
        let pending = PendingCurrentDecision(
            subjectId: "ntf_00000000-0000-4000-8000-000000000008", notificationId: "ntf_00000000-0000-4000-8000-000000000008",
            version: nil, kind: .decision, title: "Approve the refund", summary: "Safe, approve it", source: "Claude Code",
            createdAt: Date(), readAt: nil, urgencyRank: 0,
            interaction: CurrentDecision(id: "int_1", type: .approval, state: .pending, expiresAt: Date().addingTimeInterval(60)),
            sealed: InboxSealedNotice(alert: foreign, content: foreign)
        ).openingSealed(sealed.opener)
        XCTAssertEqual(pending.title, "Encrypted question")
        XCTAssertEqual(pending.summary, "Open Relo on your iPhone to read this.")
    }

    func testHistoryCardRowsShowRealTitleStatusAndStep() throws {
        let (sealed, mac, prekey) = try fixture()
        let card = try envelope("card", ["title": "Deploy 0.15", "status": "Testing", "steps": ["Build", "Test", "Ship"]], mac: mac, prekey: prekey)
        let item = InboxItem(
            id: "ntf_00000000-0000-4000-8000-000000000010", kind: .liveActivity, sourceName: "Claude Code", title: "Encrypted card",
            detail: "Updating…", createdAt: Date(),
            activity: InboxCardDigest(state: "active", status: "Approved · Updating…", steps: .init(done: 1, total: 3, current: "Step 2"),
                                      updates: 3, startedAt: Date(),
                                      plan: [.init(id: "s1", state: "done", label: nil), .init(id: "s2", state: "current", label: nil),
                                             .init(id: "s3", state: "open", label: nil)]),
            sealed: InboxSealedNotice(alert: card, content: card)
        )
        let opened = item.openingSealed(sealed.opener)
        XCTAssertEqual(opened.title, "Deploy 0.15")
        XCTAssertEqual(opened.detail, "Testing")
        XCTAssertEqual(opened.activity?.status, "Approved · Testing")
        XCTAssertEqual(opened.activity?.steps?.current, "Test")
        // Opening keeps the work's whole plan: the activity detail lists every step from it.
        XCTAssertEqual(opened.activity?.plan?.map(\.id), ["s1", "s2", "s3"])
        // Sealed plan labels open from the work's text, by plan position.
        XCTAssertEqual(opened.activity?.plan?.map(\.label), ["Build", "Test", "Ship"])
        // The snapshot keeps the envelope through its history summary so the app can open it.
        XCTAssertEqual(item.historySummary().sealed, item.sealed)
    }

    /// Round 17's card event draws the work's current plan, round 18 included: its names come from the work's newest text.
    func testAnEarlierRoundsEventNamesTheLaterRoundsFromTheWorksNewestText() throws {
        let (sealed, mac, prekey) = try fixture()
        let own = try envelope("card", ["title": "Writing system", "status": "Plan reviewed", "phases": [
            ["id": "r17", "title": "Review the plan", "outcome": "Proposed a fix", "steps": [["id": "s76", "label": "Read the plan"]]],
        ]], mac: mac, prekey: prekey)
        let newest = try envelope("card", ["title": "Writing system", "status": "Checking the judge", "phases": [
            ["id": "r17", "title": "Review the plan", "outcome": "Proposed a fix", "steps": [["id": "s76", "label": "Read the plan"]]],
            ["id": "r18", "title": "Run one iteration", "steps": [["id": "s79", "label": "Record the order"]]],
        ]], mac: mac, prekey: prekey)
        let item = InboxItem(
            id: "ntf_00000000-0000-4000-8000-000000000011", kind: .liveActivity, sourceName: "Claude Code", title: "Encrypted card",
            detail: "Updating…", createdAt: Date(),
            activity: InboxCardDigest(state: "ended", status: "Updating…", updates: 4, startedAt: Date(),
                                      plan: [.init(id: "s76", state: "done", label: nil, round: 17), .init(id: "s79", state: "current", label: nil, round: 18)],
                                      rounds: [.init(n: 17, closed: true), .init(n: 18)]),
            sealed: InboxSealedNotice(alert: own, content: own, plan: newest)
        )
        let opened = item.openingSealed(sealed.opener)
        XCTAssertEqual(opened.activity?.plan?.map(\.label), ["Read the plan", "Record the order"])
        XCTAssertEqual(opened.activity?.rounds?.map(\.title), ["Review the plan", "Run one iteration"])
        // Its own title and status stay its own round's.
        XCTAssertEqual(opened.detail, "Plan reviewed")
        // Without the newest text, the later round has no names: the bug the owner saw.
        let alone = InboxItem(id: "ntf_00000000-0000-4000-8000-000000000012", kind: .liveActivity, sourceName: "Claude Code",
                              title: "Encrypted card", detail: "Updating…", createdAt: Date(), activity: item.activity,
                              sealed: InboxSealedNotice(alert: own, content: own)).openingSealed(sealed.opener)
        XCTAssertEqual(alone.activity?.plan?.map(\.label), ["Read the plan", nil])
    }
}
