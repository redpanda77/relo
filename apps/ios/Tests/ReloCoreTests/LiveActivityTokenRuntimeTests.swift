@testable import ReloRuntime
import Foundation
import Testing
@testable import ReloCore

@Suite("One scoped token owner", .timeLimit(.minutes(1)))
struct LiveActivityTokenRuntimeTests {
    @Test func duplicateEntryPointsAndAcknowledgedTokensUploadOnce() async throws {
        let sender = ControlledTokenSender(), runtime = LiveActivityTokenRuntime()
        await runtime.configure(try binding(sender))
        for _ in 0..<100 { await runtime.offer(candidate("A")) }
        await sender.waitForCalls(1)
        await sender.complete(0, .registered)
        await runtime.waitForCurrentWork()
        await runtime.offer(candidate("A")); await runtime.waitForCurrentWork()
        #expect(await sender.values == ["native:A"])
    }

    @Test func independentActivitiesDoNotWaitForEachOther() async throws {
        let sender = ControlledTokenSender(), runtime = LiveActivityTokenRuntime()
        await runtime.configure(try binding(sender))
        await runtime.offer(candidate("A")); await sender.waitForCalls(1)
        await runtime.offer(candidate("B", native: "another")); await sender.waitForCalls(2)
        #expect(await sender.values == ["native:A", "another:B"])
        await sender.complete(1, .registered); await sender.complete(0, .registered)
        await runtime.waitForCurrentWork()
    }

    @Test func newerTokenInterruptsBackoffWithoutAnotherOldAttempt() async throws {
        let sender = ControlledTokenSender()
        let (sleeping, signal) = AsyncStream<Void>.makeStream()
        let runtime = LiveActivityTokenRuntime(sleep: { _ in
            signal.yield(()); try await Task.sleep(for: .seconds(3_600))
        })
        await runtime.configure(try binding(sender))
        await runtime.offer(candidate("A")); await sender.waitForCalls(1)
        await sender.complete(0, .retryable)
        for await _ in sleeping { break }
        await runtime.offer(candidate("B")); await sender.waitForCalls(2)
        #expect(await sender.values == ["native:A", "native:B"])
        await sender.complete(1, .registered); await runtime.waitForCurrentWork()
    }

    @Test func tokenReturningToPreviousValueIsSentAfterInFlightReplacement() async throws {
        let sender = ControlledTokenSender(), runtime = LiveActivityTokenRuntime()
        await runtime.configure(try binding(sender))
        await runtime.offer(candidate("A")); await sender.waitForCalls(1)
        await sender.complete(0, .registered); await runtime.waitForCurrentWork()
        await runtime.offer(candidate("B")); await sender.waitForCalls(2)
        await runtime.offer(candidate("A"))
        #expect(await sender.values.count == 2)
        await sender.complete(1, .registered); await sender.waitForCalls(3)
        #expect(await sender.values == ["native:A", "native:B", "native:A"])
        await sender.complete(2, .registered); await runtime.waitForCurrentWork()
    }

    @Test func scopeChangeDoesNotReuseAcknowledgementOrRetryOldAuthority() async throws {
        let old = ControlledTokenSender(), new = ControlledTokenSender(), runtime = LiveActivityTokenRuntime()
        await runtime.configure(try binding(old))
        await runtime.offer(candidate("A")); await old.waitForCalls(1)
        await runtime.configure(try binding(new, origin: "https://second.test"))
        await runtime.offer(candidate("A")); await new.waitForCalls(1)
        // The old transport deliberately ignores cancellation and returns late.
        await old.complete(0, .retryable)
        await new.complete(0, .registered); await runtime.waitForCurrentWork()
        await runtime.offer(candidate("A")); await runtime.waitForCurrentWork()
        #expect(await old.values == ["native:A"])
        #expect(await new.values == ["native:A"])
    }

    @Test func foreignAndInvalidCandidatesNeverUpload() async throws {
        let sender = ControlledTokenSender(), runtime = LiveActivityTokenRuntime()
        await runtime.configure(try binding(sender))
        await runtime.offer(candidate("A", account: "acc_other"))
        await runtime.offer(candidate(""))
        await runtime.offer(.init(activityID: "!", generation: 1, nativeActivityID: "native", token: "A", accountID: "acc_123"))
        await runtime.waitForCurrentWork()
        #expect(await sender.values.isEmpty)
    }

    @Test func pushTokenWaitsOnlyForCapturedMetadataAndDeduplicatesWithinScope() async throws {
        let sender = ControlledTokenSender(), runtime = LiveActivityTokenRuntime()
        let scope = try makeScope()
        await runtime.configure(try binding(sender, scope: scope, pushReady: false))
        await runtime.offerPushToStart("push"); await runtime.waitForCurrentWork()
        #expect(await sender.values.isEmpty)
        await runtime.configure(try binding(sender, scope: scope))
        await sender.waitForCalls(1)
        await runtime.offerPushToStart("push")
        await sender.complete(0, .registered); await runtime.waitForCurrentWork()
        await runtime.offerPushToStart("push"); await runtime.waitForCurrentWork()
        #expect(await sender.values == ["push:push"])
        await runtime.configure(try binding(sender))
        await runtime.offerPushToStart("push"); await sender.waitForCalls(2)
        await sender.complete(1, .registered); await runtime.waitForCurrentWork()
        #expect(await sender.values == ["push:push", "push:push"])
    }

    @Test func forgettingAnActivityCannotLetItsLateCleanupEraseReplacementWork() async throws {
        let sender = ControlledTokenSender(), runtime = LiveActivityTokenRuntime()
        await runtime.configure(try binding(sender))
        await runtime.offer(candidate("A")); await sender.waitForCalls(1)
        await runtime.forget(nativeActivityID: "native")
        await runtime.offer(candidate("B")); await sender.waitForCalls(2)
        await sender.complete(0, .registered)
        await runtime.offer(candidate("C"))
        await sender.complete(1, .registered); await sender.waitForCalls(3)
        await sender.complete(2, .registered); await runtime.waitForCurrentWork()
        #expect(await sender.values == ["native:A", "native:B", "native:C"])
    }

    private func makeScope(origin: String = "https://first.test") throws -> SessionScope {
        .init(storage: try .init(serverOrigin: URL(string: origin)!, accountID: "acc_123", deviceID: "dev_123"), credentialVersion: 1)
    }
    private func binding(_ sender: ControlledTokenSender, origin: String = "https://first.test", scope: SessionScope? = nil, pushReady: Bool = true) throws -> LiveActivityTokenBinding {
        let capturedScope = try scope ?? makeScope(origin: origin)
        let push: (@Sendable (String) async -> LiveActivityTokenRegistrationAttempt)?
        if pushReady { push = { await sender.send("push:" + $0) } } else { push = nil }
        return .init(scope: capturedScope, registerActivity: { await sender.send($0.nativeActivityID + ":" + $0.token) }, registerPushToStart: push)
    }
    private func candidate(_ token: String, native: String = "native", account: String = "acc_123") -> LiveActivityTokenRegistrationCandidate {
        .init(activityID: "act_123", generation: 1, nativeActivityID: native, token: token, accountID: account)
    }
}

private actor ControlledTokenSender {
    private(set) var values: [String] = []
    private var completions: [Int: CheckedContinuation<LiveActivityTokenRegistrationAttempt, Never>] = [:]
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
    func send(_ value: String) async -> LiveActivityTokenRegistrationAttempt {
        let index = values.count; values.append(value)
        return await withCheckedContinuation { completion in
            completions[index] = completion
            let ready = waiters.filter { $0.0 <= values.count }; waiters.removeAll { $0.0 <= values.count }
            ready.forEach { $0.1.resume() }
        }
    }
    func waitForCalls(_ count: Int) async {
        if values.count >= count { return }
        await withCheckedContinuation { waiters.append((count, $0)) }
    }
    func complete(_ index: Int, _ value: LiveActivityTokenRegistrationAttempt) { completions.removeValue(forKey: index)?.resume(returning: value) }
}
