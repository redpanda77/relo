@testable import ReloRuntime
import Testing
@testable import ReloCore

@Suite("Canonical badge writer", .timeLimit(.minutes(1)))
@MainActor
struct CurrentBadgeControllerTests {
    @Test func slowPriorWriteCannotOverwriteNewestCountOrSignOutClear() async {
        let (started, sink) = AsyncStream<Int>.makeStream()
        var gate: CheckedContinuation<Void, Never>?
        var writes: [Int] = []
        let owner = CurrentBadgeController { count in
            writes.append(count); sink.yield(count)
            if count == 101 { await withCheckedContinuation { gate = $0 } }
        }
        owner.set(101)
        for await count in started where count == 101 { break }
        owner.set(100); owner.set(99); owner.set(0)
        #expect(writes == [101])
        gate?.resume()
        await owner.waitForUpdate()
        #expect(writes == [101, 0])
    }

    @Test func unchangedGlobalCountDoesNotWriteAgain() async {
        var writes: [Int] = []
        let owner = CurrentBadgeController { writes.append($0) }
        owner.set(101); await owner.waitForUpdate()
        owner.set(101); await owner.waitForUpdate()
        #expect(writes == [101])
    }
}
