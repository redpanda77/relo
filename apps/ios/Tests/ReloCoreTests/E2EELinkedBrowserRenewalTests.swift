import CryptoKit
import Foundation
import XCTest
@testable import ReloCore
@testable import ReloRuntime

final class E2EELinkedBrowserRenewalTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let day: TimeInterval = 24 * 60 * 60
    private let phone = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
    private let credential = DeviceCredential(deviceId: "dev_phone", installationId: UUID(), accessToken: "device-token",
                                              issuedAt: .now, accountId: "account", credentialVersion: 1)

    private func browserID(_ n: Int) -> String { "brw_0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0\(n)" }
    private func identityKey() -> String { ReloE2EE.base64URL(P256.Signing.PrivateKey().publicKey.x963Representation) }

    private func entry(_ n: Int, signedDaysAgo days: Double, name: String = "Studio Mac") -> ReloLocalLinkedBrowser {
        ReloLocalLinkedBrowser(browserId: browserID(n), identityKey: identityKey(), name: name,
                               linkedAt: now.addingTimeInterval(-20 * day), lastSignedAt: now.addingTimeInterval(-days * day))
    }

    // MARK: Due logic

    func testOnlyLinksSignedAtLeastThreeDaysAgoAreDue() {
        let fresh = entry(1, signedDaysAgo: 2.9)
        let edge = entry(2, signedDaysAgo: 3)
        let old = entry(3, signedDaysAgo: 13)
        let lapsed = entry(4, signedDaysAgo: 30)
        let future = ReloLocalLinkedBrowser(browserId: browserID(5), identityKey: identityKey(), name: "Studio Mac",
                                            linkedAt: now, lastSignedAt: now.addingTimeInterval(day))
        XCTAssertEqual(ReloBrowserLinkRenewalPolicy.due([fresh, edge, old, lapsed, future], now: now).map(\.browserId),
                       [edge, old, lapsed, future].map(\.browserId))
        XCTAssertLessThan(ReloBrowserLinkRenewalPolicy.renewAfter, ReloBrowserLinkRenewalPolicy.acceptanceWindow)
        XCTAssertEqual(ReloBrowserLinkRenewalPolicy.acceptanceWindow, 14 * day)
    }

    func testRememberMarkSignedAndForget() throws {
        let store = MemoryLinkedBrowserStore()
        let browsers = ReloLinkedBrowsers(store: store)
        let key = identityKey()
        try browsers.remember(browserID: browserID(1), identityKey: key, name: "Studio Mac", signedAt: now)
        try browsers.remember(browserID: browserID(1), identityKey: key, name: "Studio Mac", signedAt: now.addingTimeInterval(60))
        XCTAssertEqual(try browsers.all().count, 1)
        XCTAssertEqual(try browsers.all().first?.linkedAt, now.addingTimeInterval(60))

        // A renewal for a changed identity never updates the entry.
        try browsers.markSigned(browserID: browserID(1), identityKey: identityKey(), name: nil, at: now.addingTimeInterval(day))
        XCTAssertEqual(try browsers.all().first?.lastSignedAt, now.addingTimeInterval(60))
        try browsers.markSigned(browserID: browserID(1), identityKey: key, name: "Office Chrome", at: now.addingTimeInterval(day))
        XCTAssertEqual(try browsers.all().first?.lastSignedAt, now.addingTimeInterval(day))
        XCTAssertEqual(try browsers.all().first?.name, "Office Chrome")
        XCTAssertEqual(try browsers.all().first?.linkedAt, now.addingTimeInterval(60))

        try browsers.forget(browserID: browserID(1))
        XCTAssertEqual(try browsers.all(), [])
        // Unlinked: a late renewal does not bring it back.
        try browsers.markSigned(browserID: browserID(1), identityKey: key, name: nil, at: now)
        XCTAssertEqual(try browsers.all(), [])
    }

    func testEntriesRoundTripThroughJSON() throws {
        let original = [entry(1, signedDaysAgo: 4)]
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        XCTAssertEqual(try decoder.decode([ReloLocalLinkedBrowser].self, from: encoder.encode(original)), original)
    }

    // MARK: Renewal

    func testRenewalReSignsDueLinksAndUpdatesOn200() async throws {
        let due = entry(1, signedDaysAgo: 5)
        let fresh = entry(2, signedDaysAgo: 1)
        let store = MemoryLinkedBrowserStore([due, fresh])
        let linker = StubLinker(results: [due.browserId: .success("Studio Mac")])
        let outcome = await BrowserLinkRenewal(browsers: ReloLinkedBrowsers(store: store), linker: linker)
            .run(credential: credential, signer: phone, now: now)

        XCTAssertEqual(outcome.renewed, [due.browserId])
        let posted = await linker.posted
        XCTAssertEqual(posted.map(\.browserId), [due.browserId])
        let request = try XCTUnwrap(posted.first)
        XCTAssertEqual(request.identityKey, due.identityKey)
        XCTAssertEqual(ReloKeyRing.date(request.signedAt), now)
        let signature = try ReloE2EE.data(base64URL: request.signature, field: "signature")
        XCTAssertTrue(ReloE2EE.verify(signature: signature, message: ReloBrowserLink.signingInput(
            browserID: due.browserId, identityKey: due.identityKey, phoneDeviceID: "dev_phone", signedAt: request.signedAt),
            publicKeyX963: phone.publicKeyX963))

        let saved = try store.load()
        XCTAssertEqual(saved.first { $0.browserId == due.browserId }?.lastSignedAt, now)
        XCTAssertEqual(saved.first { $0.browserId == fresh.browserId }, fresh)
    }

    func testRenewalRemovesBrowsersTheServerNoLongerKnowsOrWhoseIdentityChanged() async throws {
        let gone = entry(1, signedDaysAgo: 4)
        let changed = entry(2, signedDaysAgo: 4)
        let offline = entry(3, signedDaysAgo: 4)
        let store = MemoryLinkedBrowserStore([gone, changed, offline])
        let linker = StubLinker(results: [
            gone.browserId: .failure(.unknownBrowser),
            changed.browserId: .failure(.identityMismatch),
        ])
        let outcome = await BrowserLinkRenewal(browsers: ReloLinkedBrowsers(store: store), linker: linker)
            .run(credential: credential, signer: phone, now: now)

        XCTAssertEqual(Set(outcome.removed), [gone.browserId, changed.browserId])
        XCTAssertEqual(outcome.failed, [offline.browserId])
        // A network failure keeps the entry, unchanged, for the next upkeep.
        XCTAssertEqual(try store.load(), [offline])
    }

    func testRenewalNeverSignsABrowserOutsideTheLocalList() async throws {
        let store = MemoryLinkedBrowserStore([])
        let linker = StubLinker(results: [:], serverList: [ReloLinkedBrowser(browserId: browserID(9), name: "Studio Mac",
                                                                           linkedAt: "2026-01-01T00:00:00.000Z")])
        let outcome = await BrowserLinkRenewal(browsers: ReloLinkedBrowsers(store: store), linker: linker)
            .run(credential: credential, signer: phone, now: now)
        XCTAssertEqual(outcome, .init())
        let posted = await linker.posted
        XCTAssertEqual(posted, [])
        let listCalls = await linker.listCalls
        XCTAssertEqual(listCalls, 0)
    }

    func testRenewalSkipsABrowserUnlinkedWhileItRuns() async throws {
        let first = entry(1, signedDaysAgo: 4)
        let second = entry(2, signedDaysAgo: 4)
        let store = MemoryLinkedBrowserStore([first, second])
        let browsers = ReloLinkedBrowsers(store: store)
        // The owner unlinks the second browser while the first renewal is in flight.
        let linker = StubLinker(results: [first.browserId: .success("Studio Mac")]) {
            try? browsers.forget(browserID: second.browserId)
        }
        let outcome = await BrowserLinkRenewal(browsers: browsers, linker: linker).run(credential: credential, signer: phone, now: now)
        XCTAssertEqual(outcome.renewed, [first.browserId])
        let posted = await linker.posted
        XCTAssertEqual(posted.map(\.browserId), [first.browserId])
        XCTAssertEqual(try store.load().map(\.browserId), [first.browserId])
    }

    func testKeyUpkeepRenewsWithThePhoneIdentityKey() async throws {
        let ring = ReloKeyRing(store: MemoryKeyRingStore(), factory: ReloSoftwareKeyFactory())
        let identity = try ring.maintain(now: now).identity.publicKey
        let due = entry(1, signedDaysAgo: 4)
        let store = MemoryLinkedBrowserStore([due])
        let linker = StubLinker(results: [due.browserId: .success("Studio Mac")])
        let maintenance = E2EEKeyMaintenance(ring: ring, publisher: NoPublisher(),
                                             browserLinks: BrowserLinkRenewal(browsers: ReloLinkedBrowsers(store: store), linker: linker))
        _ = try await maintenance.run(credential: credential, now: now)
        let posted = await linker.posted
        let request = try XCTUnwrap(posted.first)
        XCTAssertTrue(ReloE2EE.verify(signature: try ReloE2EE.data(base64URL: request.signature, field: "signature"),
                                      message: ReloBrowserLink.signingInput(browserID: due.browserId, identityKey: due.identityKey,
                                                                            phoneDeviceID: "dev_phone", signedAt: request.signedAt),
                                      publicKeyX963: identity))
        XCTAssertEqual(try store.load().first?.lastSignedAt, now)
    }

    func testRenewalWithoutKeysSignsNothing() async {
        let store = MemoryLinkedBrowserStore([entry(1, signedDaysAgo: 10)])
        let linker = StubLinker(results: [:])
        let outcome = await BrowserLinkRenewal(browsers: ReloLinkedBrowsers(store: store), linker: linker)
            .run(credential: credential, signer: nil, now: now)
        XCTAssertEqual(outcome, .init())
        let posted = await linker.posted
        XCTAssertEqual(posted, [])
    }
}

private final class MemoryLinkedBrowserStore: ReloLinkedBrowserStore, @unchecked Sendable {
    private let lock = NSLock()
    private var browsers: [ReloLocalLinkedBrowser]

    init(_ browsers: [ReloLocalLinkedBrowser] = []) { self.browsers = browsers }

    func load() throws -> [ReloLocalLinkedBrowser] { lock.withLock { browsers } }
    func save(_ browsers: [ReloLocalLinkedBrowser]) throws { lock.withLock { self.browsers = browsers } }
}

private actor StubLinker: BrowserLinking {
    private let results: [String: Result<String, BrowserLinkError>]
    private let serverList: [ReloLinkedBrowser]
    private let onPost: @Sendable () -> Void
    private(set) var posted: [ReloBrowserLinkRequest] = []
    private(set) var listCalls = 0

    init(results: [String: Result<String, BrowserLinkError>], serverList: [ReloLinkedBrowser] = [],
         onPost: @escaping @Sendable () -> Void = {}) {
        self.results = results
        self.serverList = serverList
        self.onPost = onPost
    }

    func linkBrowser(credential: DeviceCredential, request: ReloBrowserLinkRequest) async throws -> ReloLinkedBrowser {
        posted.append(request)
        onPost()
        switch results[request.browserId] {
        case .success(let name)?: return ReloLinkedBrowser(browserId: request.browserId, name: name, linkedAt: request.signedAt)
        case .failure(let error)?: throw error
        case nil: throw MobileAPIError.unavailable
        }
    }

    func linkedBrowsers(credential: DeviceCredential) async throws -> [ReloLinkedBrowser] {
        listCalls += 1
        return serverList
    }

    func unlinkBrowser(credential: DeviceCredential, browserID: String) async throws {}
}

private final class MemoryKeyRingStore: ReloKeyRingStore, @unchecked Sendable {
    private let lock = NSLock()
    private var state: ReloKeyRingState?
    func load() throws -> ReloKeyRingState? { lock.withLock { state } }
    func save(_ state: ReloKeyRingState) throws { lock.withLock { self.state = state } }
    func delete() throws { lock.withLock { state = nil } }
}

private struct NoPublisher: DeviceKeyPublishing {
    func publishDeviceKeys(credential: DeviceCredential, keys: ReloPublishedDeviceKeys) async throws {}
}
