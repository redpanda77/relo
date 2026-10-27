import Foundation
import Observation
import ReloCore
import ReloTransport
import Testing
@testable import ReloNotchKit

final class Fired: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    func set() { lock.withLock { flag = true } }
    var value: Bool { lock.withLock { flag } }
}

@Suite @MainActor struct NotchStoreRefreshTests {
    private func summary() throws -> NowSummary {
        struct Fixture: Decodable { let nowSummary: NowSummary }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../ios/Tests/ReloCoreTests/Fixtures/owner-state-v1.json").standardizedFileURL
        return try ReloWireJSON.decoder().decode(Fixture.self, from: Data(contentsOf: url)).nowSummary
    }

    /// Whether reading everything the screens read changes (once) after `change` runs.
    private func publishes(_ store: ReloNotchStore, _ change: () -> Void) -> Bool {
            let fired = Fired()
        withObservationTracking {
            _ = (store.summary, store.presentation, store.questions, store.answers, store.connection,
                 store.problem, store.showingCached, store.notices, store.lastUpdated)
        } onChange: { fired.set() }
        change()
        return fired.value
    }

    @Test func anIdenticalNowPublishesNothing() throws {
        let store = ReloNotchStore()
        let now = try summary()
        store.receive(now)
        #expect(publishes(store) { store.receive(now) } == false)
    }

    @Test func aChangedNowStillPublishes() throws {
        let store = ReloNotchStore()
        var now = try summary()
        store.receive(now)
        now.serverTime = now.serverTime.addingTimeInterval(5)
        #expect(publishes(store) { store.receive(now) })
        #expect(store.summary == now)
    }

    @Test func aReadThatOnlyDiffersInServerTimeIsTheSameNow() {
        let a = Data(#"{"serverTime":1761470000123,"needsYou":[],"x":"serverTime"}"#.utf8)
        let b = Data(#"{"serverTime":1761470005999,"needsYou":[],"x":"serverTime"}"#.utf8)
        let c = Data(#"{"serverTime":1761470005999,"needsYou":[1],"x":"serverTime"}"#.utf8)
        let iso1 = Data(#"{"serverTime": "2026-10-26T10:00:00.000Z","n":1}"#.utf8)
        let iso2 = Data(#"{"serverTime": "2026-10-26T10:00:09.000Z","n":1}"#.utf8)
        #expect(ReloNotchStore.sameNow(b, a))
        #expect(!ReloNotchStore.sameNow(c, a))
        #expect(ReloNotchStore.sameNow(iso2, iso1))
        #expect(!ReloNotchStore.sameNow(a, nil))
    }
}
