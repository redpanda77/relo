import Foundation
import ReloCore
import ReloNotificationSupport
import Testing
@testable import ReloNotchKit

/// Counts what a stand-in Keychain was asked.
private final class Counting: @unchecked Sendable {
    private let lock = NSLock()
    private var loads = 0
    private var learns = 0
    func load() { lock.withLock { loads += 1 } }
    func learn() { lock.withLock { learns += 1 } }
    var loadCount: Int { lock.withLock { loads } }
    var learnCount: Int { lock.withLock { learns } }
}

private struct StubRingStore: ReloKeyRingStore {
    let counting: Counting
    func load() throws -> ReloKeyRingState? { counting.load(); return nil }
    func save(_ state: ReloKeyRingState) throws {}
    func delete() throws {}
}

private struct StubTrustStore: ReloTrustedClientStore {
    let counting: Counting
    func load() throws -> [ReloTrustedClient] { counting.load(); return [] }
    func save(_ clients: [ReloTrustedClient]) throws {}
}

private final class StubNameBook: ReloNameBook, @unchecked Sendable {
    let counting: Counting
    private let lock = NSLock()
    private var book: [String: String] = [:]
    init(_ counting: Counting) { self.counting = counting }
    func names() -> [String: String] { lock.withLock { book } }
    func learn(_ names: [String: String], sender: String) {
        counting.learn()
        lock.withLock { book.merge(ReloNames.accepted(names)) { $1 } }
    }
}

private final class ThreadLog: @unchecked Sendable {
    private let lock = NSLock()
    private var marks: [Bool] = []
    func note() { lock.withLock { marks.append(Thread.isMainThread) } }
    var onMain: [Bool] { lock.withLock { marks } }
}

@Suite @MainActor struct NotchStoreOffMainTests {
    private let origin = URL(string: "http://127.0.0.1:9")!

    private func fixtureData() throws -> Data {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../ios/Tests/ReloCoreTests/Fixtures/owner-state-v1.json").standardizedFileURL
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        return try JSONSerialization.data(withJSONObject: try #require(object?["nowSummary"]))
    }

    private func kit(_ counting: Counting) -> SealedKit {
        SealedKit(ring: ReloKeyRing(store: StubRingStore(counting: counting), factory: ReloSoftwareKeyFactory()),
                  trust: ReloTrustedClients(store: StubTrustStore(counting: counting)), ledger: nil,
                  nameBook: StubNameBook(counting))
    }

    @Test func theExpensiveWorkOfAReadRunsOffTheMainThread() async throws {
        let store = ReloNotchStore()
        store.sealed = kit(Counting())
        let log = ThreadLog()
        store.nowWorkProbe = { log.note() }
        try await store.applyNowDataForTesting(fixtureData(), origin: origin, token: "t")
        #expect(log.onMain == [false])
        #expect(store.summary != nil)
    }

    @Test func offMainResultMatchesWhatTheMainActorBuilds() async throws {
        let store = ReloNotchStore()
        store.sealed = kit(Counting())
        let data = try fixtureData()
        try await store.applyNowDataForTesting(data, origin: origin, token: "t")
        let direct = try ReloNotchStore.processNow(data, baseURL: origin, token: "t", kit: store.sealed)
        #expect(store.summary == direct.summary)
        #expect(store.plans == direct.plans)
        #expect(store.spokenLines == direct.spoken)
        #expect(store.presentation == direct.presentation)
        #expect(direct.presentation == NotchPresentation(summary: direct.summary, plans: direct.plans, spoken: direct.spoken))
    }

    @Test func theKeychainIsReadOncePerKindNotOncePerRead() throws {
        let counting = Counting()
        let kit = kit(counting)
        let data = try fixtureData()
        for _ in 0..<5 {
            kit.warm()
            _ = try ReloNotchStore.processNow(data, baseURL: origin, token: "t", kit: kit)
        }
        #expect(counting.loadCount == 2)  // the key ring and the trusted computers, once each
        kit.invalidate()
        kit.warm()
        #expect(counting.loadCount == 4)
    }

    @Test func aNameBookWritesOnlyWhenSomethingIsNew() {
        let counting = Counting()
        let book = CachedNameBook(StubNameBook(counting))
        let handle = "p-abcdefghijklmnop"
        book.learn([handle: "Billing"], sender: "k1")
        book.learn([handle: "Billing"], sender: "k1")
        book.learn([handle: "Billing"], sender: "k2")
        #expect(counting.learnCount == 1)
        #expect(book.names()[handle] == "Billing")
        book.learn([handle: "Payments"], sender: "k1")
        #expect(counting.learnCount == 2)
    }

    @Test func aCachedStoreReadsOnceUntilInvalidated() throws {
        let counting = Counting()
        let store = CachedTrustedClientStore(StubTrustStore(counting: counting))
        for _ in 0..<4 { _ = try store.load() }
        #expect(counting.loadCount == 1)
        store.invalidate()
        _ = try store.load()
        #expect(counting.loadCount == 2)
    }

    @Test func aNewerReadIsNeverOverwrittenByAnOlderOne() async throws {
        let store = ReloNotchStore()
        store.sealed = kit(Counting())
        let data = try fixtureData()
        var newer = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        newer["serverTime"] = "2030-01-01T00:00:00.000Z"
        let newerData = try JSONSerialization.data(withJSONObject: newer)
        // The newer read applies first (the older one is held back), then the older one finishes: it must not win.
        try await store.applyNowDataForTesting(newerData, origin: origin, token: "t", generation: 2)
        try await store.applyNowDataForTesting(data, origin: origin, token: "t", generation: 1)
        let served = try #require(store.summary)
        #expect(served.serverTime.timeIntervalSince1970 > 1_800_000_000)
    }
}
