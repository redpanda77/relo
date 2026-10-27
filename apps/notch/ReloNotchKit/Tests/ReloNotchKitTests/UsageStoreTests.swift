import Foundation
import Testing
@testable import ReloNotchKit

/// Shared fake world: a clock, a queue of command outputs and a record of the waits the store asked for.
final class UsageWorld: @unchecked Sendable {
    private let lock = NSLock()
    private var _now = Date(timeIntervalSince1970: 1_793_112_000)
    private var _outputs: [Data?] = []
    private var _last: Data?
    private var _sleeps: [TimeInterval] = []
    private var _reads = 0
    var now: Date { lock.withLock { _now } }
    var sleeps: [TimeInterval] { lock.withLock { _sleeps } }
    var reads: Int { lock.withLock { _reads } }
    func advance(_ s: TimeInterval) { lock.withLock { _now = _now.addingTimeInterval(s) } }
    func queue(_ d: Data?) { lock.withLock { _outputs.append(d) } }
    func set(_ d: Data?) { lock.withLock { _last = d; _outputs = [] } }
    func read() -> Data? {
        lock.withLock {
            _reads += 1
            if !_outputs.isEmpty { _last = _outputs.removeFirst() }
            return _last
        }
    }
    func slept(_ s: TimeInterval) { lock.withLock { _sleeps.append(s) } }

    static func json(_ percent: Double, resetsIn: TimeInterval = 3600, readAgo: TimeInterval = 0, id: String = "claude", now: Date) -> Data {
        let reset = Int(now.timeIntervalSince1970 + resetsIn)
        let readAt = Int((now.timeIntervalSince1970 - readAgo) * 1000)
        return Data(#"{"accounts":[{"id":"\#(id)","plan":"claude","connected":true,"readAt":\#(readAt),"windows":[{"kind":"five_hour","minutes":300,"usedPercent":\#(percent),"resetsAt":\#(reset)}]}]}"#.utf8)
    }
}

@MainActor
struct UsageStoreTests {
    private func makeStore(_ world: UsageWorld, busy: @escaping @MainActor () -> Bool = { false },
                           sleep: @escaping UsageStore.Sleeper = { _ in }) -> UsageStore {
        UsageStore(read: { world.read() }, isBusy: busy, now: { world.now }, sleep: sleep)
    }

    @Test func cadenceFollowsBusyAndLooking() async {
        let world = UsageWorld()
        var busy = false
        let store = makeStore(world, busy: { busy })
        #expect(store.interval == 300)
        busy = true
        #expect(store.interval == 30)

        world.set(UsageWorld.json(10, now: world.now))
        await store.refreshNow()
        #expect(world.reads == 1)
        await store.refreshBecauseLooking()
        #expect(world.reads == 1)
        world.advance(14)
        await store.refreshBecauseLooking()
        #expect(world.reads == 1)
        world.advance(2)
        await store.refreshBecauseLooking()
        #expect(world.reads == 2)
        await store.refreshNow()
        #expect(world.reads == 3)
    }

    @Test func loopSleepsTheCadenceBetweenReads() async {
        let world = UsageWorld()
        world.set(UsageWorld.json(10, now: world.now))
        var busy = true
        let store = makeStore(world, busy: { busy }, sleep: { s in
            world.slept(s)
            if world.sleeps.count >= 3 { try? await Task.sleep(for: .seconds(3600)) } else { await Task.yield() }
        })
        store.start()
        while world.sleeps.count < 2 { await Task.yield() }
        busy = false
        while world.sleeps.count < 3 { await Task.yield() }
        store.stop()
        #expect(Array(world.sleeps.prefix(3)) == [30, 30, 300])
        #expect(world.reads >= 3)
    }

    @Test func failureKeepsTheLastReading() async {
        let world = UsageWorld()
        let store = makeStore(world)
        world.set(nil)
        await store.refreshNow()
        #expect(store.accounts.isEmpty)
        world.set(UsageWorld.json(10, now: world.now))
        await store.refreshNow()
        #expect(store.accounts.count == 1)
        world.set(nil)
        await store.refreshNow()
        #expect(store.accounts.count == 1)
    }

    @Test func keepsLastGoodReadingAndDropsUnlistedAccounts() async {
        let world = UsageWorld()
        let both = Data(#"{"accounts":[{"id":"claude","plan":"claude","connected":true,"readAt":1793112000000,"windows":[{"kind":"five_hour","minutes":300,"usedPercent":40,"resetsAt":1793115000}]},{"id":"codex","plan":"codex","connected":true,"readAt":1793112000000,"windows":[{"kind":"primary","minutes":300,"usedPercent":5,"resetsAt":1793115000}]}]}"#.utf8)
        world.set(both)
        let store = makeStore(world)
        await store.refreshNow()
        #expect(store.accounts.map(\.id) == ["claude", "codex"])

        world.set(Data(#"{"accounts":[{"id":"claude","plan":"claude","connected":true,"readAt":null,"windows":[]}]}"#.utf8))
        world.advance(20 * 60)
        await store.refreshNow()
        #expect(store.accounts.map(\.id) == ["claude"])
        #expect(store.accounts[0].windows.first?.usedPercent == 40)
        #expect(store.accounts[0].isStale(now: world.now))
    }

    @Test func expiredWindowsDisappearFromTheShownAccount() async {
        let world = UsageWorld()
        world.set(UsageWorld.json(40, resetsIn: -10, now: world.now))
        let store = makeStore(world)
        await store.refreshNow()
        #expect(store.accounts[0].windows.isEmpty)
    }

    // MARK: crossings

    private func run(_ percents: [Double], resetsIn: TimeInterval = 3600, step: TimeInterval = 30) async -> [UsageCrossing.Kind] {
        let world = UsageWorld()
        let store = makeStore(world)
        var seen: [UsageCrossing.Kind] = []
        store.onCrossing = { seen.append($0.kind) }
        for p in percents {
            world.set(UsageWorld.json(p, resetsIn: resetsIn, now: world.now))
            await store.refreshNow()
            world.advance(step)
        }
        return seen
    }

    @Test func firstReadingOnlySeeds() async {
        #expect(await run([85]).isEmpty)
        #expect(await run([100, 100]).isEmpty)
    }

    @Test func crossing80FiresOnce() async {
        #expect(await run([70, 82, 85, 90, 79, 83]) == [.crossed80])
    }

    @Test func reaching100FiresOnce() async {
        #expect(await run([70, 100, 100]) == [.reached100])
        #expect(await run([70, 85, 99.5, 100]) == [.crossed80, .reached100])
        #expect(await run([70, 99.4]) == [.crossed80])
    }

    @Test func resetByDropThenCrossingAgain() async {
        #expect(await run([60, 85, 5, 10, 90]) == [.crossed80, .reset, .crossed80])
        #expect(await run([20, 5]).isEmpty) // not from >= 30
    }

    @Test func resetByTimePassing() async {
        let world = UsageWorld()
        let store = makeStore(world)
        var seen: [UsageCrossing.Kind] = []
        store.onCrossing = { seen.append($0.kind) }
        world.set(UsageWorld.json(85, resetsIn: 600, now: world.now))
        await store.refreshNow()
        world.advance(700)
        // The command still lists the expired window: reported once, not repeated.
        world.set(UsageWorld.json(85, resetsIn: -100, now: world.now))
        await store.refreshNow()
        await store.refreshNow()
        #expect(seen == [.reset])
        // The window comes back fresh and high: it may cross again.
        world.set(UsageWorld.json(82, resetsIn: 3600, now: world.now))
        await store.refreshNow()
        #expect(seen == [.reset, .crossed80])
    }

    @Test func resetWhenWindowStopsBeingListed() async {
        let world = UsageWorld()
        let store = makeStore(world)
        var seen: [UsageCrossing.Kind] = []
        store.onCrossing = { seen.append($0.kind) }
        world.set(UsageWorld.json(60, resetsIn: 600, now: world.now))
        await store.refreshNow()
        world.advance(700)
        world.set(Data(#"{"accounts":[{"id":"claude","plan":"claude","connected":true,"windows":[]}]}"#.utf8))
        await store.refreshNow()
        #expect(seen == [.reset])
        await store.refreshNow()
        #expect(seen == [.reset])
    }
}
