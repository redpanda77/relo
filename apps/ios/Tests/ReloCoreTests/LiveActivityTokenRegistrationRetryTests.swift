import XCTest
@testable import ReloCore

final class LiveActivityTokenRegistrationRetryTests: XCTestCase {
    func testRetriesTransientFailureWithBoundedBackoffThenRegisters() async {
        let probe = RetryProbe(results: [.retryable, .retryable, .registered])
        let candidate = LiveActivityTokenRegistrationCandidate(
            activityID: "act_123",
            generation: 3,
            nativeActivityID: "native-123",
            token: "aabbcc",
            accountID: "acc_123"
        )

        let outcome = await LiveActivityTokenRegistrationRetrier.run(
            candidate,
            retryDelays: [.milliseconds(10), .milliseconds(20), .milliseconds(40)],
            attempt: { candidate in
                await probe.attempt(candidate)
            },
            sleep: { delay in
                await probe.record(delay)
            }
        )

        XCTAssertEqual(outcome, .registered)
        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.attemptCount, 3)
        XCTAssertEqual(snapshot.delays, [.milliseconds(10), .milliseconds(20)])
        XCTAssertEqual(snapshot.candidates, [candidate, candidate, candidate])
    }

    func testTerminalFailureDoesNotRetryOrSleep() async {
        let probe = RetryProbe(results: [.terminal, .registered])
        let candidate = LiveActivityTokenRegistrationCandidate(
            activityID: "act_terminal",
            generation: 1,
            nativeActivityID: "native-terminal",
            token: "deadbeef",
            accountID: "acc_terminal"
        )

        let outcome = await LiveActivityTokenRegistrationRetrier.run(
            candidate,
            attempt: { candidate in await probe.attempt(candidate) },
            sleep: { delay in await probe.record(delay) }
        )

        XCTAssertEqual(outcome, .terminal)
        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.attemptCount, 1)
        XCTAssertTrue(snapshot.delays.isEmpty)
    }

    func testRetryExhaustionUsesExactlyFiveAttempts() async {
        let probe = RetryProbe(results: Array(repeating: .retryable, count: 5))
        let candidate = LiveActivityTokenRegistrationCandidate(
            activityID: "act_offline",
            generation: 2,
            nativeActivityID: "native-offline",
            token: "001122",
            accountID: "acc_offline"
        )

        let outcome = await LiveActivityTokenRegistrationRetrier.run(
            candidate,
            attempt: { candidate in await probe.attempt(candidate) },
            sleep: { delay in await probe.record(delay) }
        )

        XCTAssertEqual(outcome, .exhausted)
        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.attemptCount, 5)
        XCTAssertEqual(snapshot.delays, LiveActivityTokenRegistrationRetrier.retryDelays)
    }

    func testInvalidCandidateFailsClosedBeforeAttempt() async {
        let probe = RetryProbe(results: [.registered])
        let outcome = await LiveActivityTokenRegistrationRetrier.run(
            LiveActivityTokenRegistrationCandidate(
                activityID: "bad id",
                generation: 0,
                nativeActivityID: "native",
                token: "token",
                accountID: "acc_invalid"
            ),
            attempt: { candidate in await probe.attempt(candidate) }
        )

        XCTAssertEqual(outcome, .invalid)
        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.attemptCount, 0)
    }

    func testGenericRetrySupportsPushToStartHeartbeatWithoutFakeActivityIdentity() async {
        let probe = RetryProbe(results: [.retryable, .registered])
        let outcome = await LiveActivityTokenRegistrationRetrier.run(
            retryDelays: [.milliseconds(5)],
            attempt: { await probe.attemptWithoutCandidate() },
            sleep: { delay in await probe.record(delay) }
        )

        XCTAssertEqual(outcome, .registered)
        let snapshot = await probe.snapshot()
        XCTAssertEqual(snapshot.attemptCount, 2)
        XCTAssertEqual(snapshot.delays, [.milliseconds(5)])
        XCTAssertTrue(snapshot.candidates.isEmpty)
    }

    func testCandidateAccountScopeAlwaysRequiresAnExactAccount() {
        let scoped = LiveActivityTokenRegistrationCandidate(
            activityID: "act_scoped",
            generation: 4,
            nativeActivityID: "native-scoped",
            token: "aabb",
            accountID: "acc_one"
        )
        XCTAssertTrue(scoped.matches(accountID: "acc_one"))
        XCTAssertFalse(scoped.matches(accountID: "acc_two"))
        XCTAssertFalse(scoped.matches(accountID: nil))
    }
}

private actor RetryProbe {
    struct Snapshot: Sendable {
        let attemptCount: Int
        let delays: [Duration]
        let candidates: [LiveActivityTokenRegistrationCandidate]
    }

    private var results: [LiveActivityTokenRegistrationAttempt]
    private var attemptCount = 0
    private var delays: [Duration] = []
    private var candidates: [LiveActivityTokenRegistrationCandidate] = []

    init(results: [LiveActivityTokenRegistrationAttempt]) {
        self.results = results
    }

    func attempt(_ candidate: LiveActivityTokenRegistrationCandidate) -> LiveActivityTokenRegistrationAttempt {
        candidates.append(candidate)
        return nextResult()
    }

    func attemptWithoutCandidate() -> LiveActivityTokenRegistrationAttempt {
        nextResult()
    }

    func record(_ delay: Duration) {
        delays.append(delay)
    }

    func snapshot() -> Snapshot {
        Snapshot(attemptCount: attemptCount, delays: delays, candidates: candidates)
    }

    private func nextResult() -> LiveActivityTokenRegistrationAttempt {
        defer { attemptCount += 1 }
        guard attemptCount < results.count else { return .retryable }
        return results[attemptCount]
    }
}
