@testable import ReloRuntime
import Foundation
import Testing
@testable import ReloCore

@Suite("Token retry cancellation")
struct TokenRetryCancellationTests {
    @Test func alreadyCancelledTaskMakesNoAttempt() async {
        let count = TokenAttemptCount()
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return await LiveActivityTokenRegistrationRetrier.run(attempt: {
                await count.increment(); return .retryable
            }, sleep: { _ in Issue.record("Cancelled retry slept") })
        }
        #expect(await task.value == .cancelled)
        #expect(await count.value == 0)
    }

    @Test func cancellationDuringAttemptPreventsBackoffAndRetry() async {
        let count = TokenAttemptCount()
        let task = Task {
            await LiveActivityTokenRegistrationRetrier.run(attempt: {
                await count.increment()
                withUnsafeCurrentTask { $0?.cancel() }
                return .retryable
            }, sleep: { _ in Issue.record("Cancelled retry slept") })
        }
        #expect(await task.value == .cancelled)
        #expect(await count.value == 1)
    }

    @Test func cancellationDuringBackoffPreventsAnotherNetworkAttempt() async {
        let count = TokenAttemptCount()
        let (waiting, signal) = AsyncStream<Void>.makeStream()
        let task = Task {
            await LiveActivityTokenRegistrationRetrier.run(attempt: {
                await count.increment(); return .retryable
            }, sleep: { _ in signal.yield(()); try await Task.sleep(for: .seconds(3_600)) })
        }
        for await _ in waiting { break }
        task.cancel()
        #expect(await task.value == .cancelled)
        #expect(await count.value == 1)
    }
}

private actor TokenAttemptCount {
    private(set) var value = 0
    func increment() { value += 1 }
}
