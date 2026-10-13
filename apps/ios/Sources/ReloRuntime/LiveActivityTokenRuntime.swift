import ReloCore
import Foundation

/// Captured authority and transport. Registration attempts never look up global credentials.
public struct LiveActivityTokenBinding: Sendable {
    public let scope: SessionScope
    public let registerActivity: @Sendable (LiveActivityTokenRegistrationCandidate) async -> LiveActivityTokenRegistrationAttempt
    public let registerPushToStart: (@Sendable (String) async -> LiveActivityTokenRegistrationAttempt)?
    public init(scope: SessionScope,
                registerActivity: @escaping @Sendable (LiveActivityTokenRegistrationCandidate) async -> LiveActivityTokenRegistrationAttempt,
                registerPushToStart: (@Sendable (String) async -> LiveActivityTokenRegistrationAttempt)?) {
        self.scope = scope; self.registerActivity = registerActivity; self.registerPushToStart = registerPushToStart
    }
}

/// One process owner for native token candidates from foreground and background entry points.
/// Independent activities have independent sends; one activity serializes its token changes.
public actor LiveActivityTokenRuntime {
    private var binding: LiveActivityTokenBinding?
    private var epoch: UInt64 = 0
    private var desired: [String: LiveActivityTokenRegistrationCandidate] = [:]
    private var registered: [String: LiveActivityTokenRegistrationCandidate] = [:]
    private struct ActivityTask { let id: UUID; let task: Task<Void, Never> }
    private var tasks: [String: ActivityTask] = [:]
    private var waits: [String: Task<Void, Error>] = [:]
    private var desiredPush: String?
    private var registeredPush: String?
    private var pushTask: Task<Void, Never>?
    private var pushWait: Task<Void, Error>?
    private let sleep: @Sendable (Duration) async throws -> Void

    public init(sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.sleep = sleep
    }

    public func configure(_ next: LiveActivityTokenBinding?) {
        if binding?.scope != next?.scope {
            epoch &+= 1
            tasks.values.forEach { $0.task.cancel() }; waits.values.forEach { $0.cancel() }
            pushTask?.cancel(); pushWait?.cancel()
            tasks = [:]; waits = [:]; desired = [:]; registered = [:]
            desiredPush = nil; registeredPush = nil; pushTask = nil; pushWait = nil
        }
        binding = next
        startPushIfNeeded()
    }

    public func offer(_ candidate: LiveActivityTokenRegistrationCandidate) {
        guard candidate.isValid, let binding,
              candidate.matches(accountID: binding.scope.storage.accountID) else { return }
        let id = candidate.nativeActivityID
        if registered[id] == candidate, desired[id] == nil, tasks[id] == nil { return }
        if desired[id] != candidate { waits[id]?.cancel() }
        desired[id] = candidate
        guard tasks[id] == nil else { return }
        let captured = epoch, operation = UUID()
        tasks[id] = ActivityTask(id: operation, task: Task { [weak self] in
            await self?.drain(id: id, operation: operation, epoch: captured)
        })
    }

    public func offerPushToStart(_ token: String) {
        guard !token.isEmpty, binding != nil else { return }
        if registeredPush == token, desiredPush == nil, pushTask == nil { return }
        if desiredPush != token { pushWait?.cancel() }
        desiredPush = token
        startPushIfNeeded()
    }

    public func forget(nativeActivityID: String) {
        tasks.removeValue(forKey: nativeActivityID)?.task.cancel()
        waits.removeValue(forKey: nativeActivityID)?.cancel()
        desired.removeValue(forKey: nativeActivityID)
        registered.removeValue(forKey: nativeActivityID)
    }

    /// Joins the work owned at invocation; later offers remain independently owned.
    public func waitForCurrentWork() async {
        let current = tasks.values.map(\.task)
        let push = pushTask
        for task in current { await task.value }
        await push?.value
    }

    private func valid(_ captured: UInt64) -> Bool { captured == epoch && binding != nil && !Task.isCancelled }

    private func drain(id: String, operation: UUID, epoch captured: UInt64) async {
        defer { if captured == epoch, tasks[id]?.id == operation { tasks[id] = nil } }
        while valid(captured), let candidate = desired[id], let binding {
            if registered[id] == candidate { desired[id] = nil; return }
            let result = await LiveActivityTokenRegistrationRetrier.run(candidate, attempt: { [weak self] candidate in
                guard await self?.isDesired(candidate, epoch: captured) == true else { return .terminal }
                return await binding.registerActivity(candidate)
            }, sleep: { [weak self] delay in
                guard let self else { throw CancellationError() }
                try await self.pause(id: id, operation: operation, candidate: candidate, epoch: captured, delay: delay)
            })
            guard valid(captured) else { return }
            if result == .registered { registered[id] = candidate }
            guard desired[id] == candidate else { continue }
            desired[id] = nil
        }
    }

    private func isDesired(_ candidate: LiveActivityTokenRegistrationCandidate, epoch captured: UInt64) -> Bool {
        valid(captured) && desired[candidate.nativeActivityID] == candidate
    }

    private func pause(id: String, operation: UUID, candidate: LiveActivityTokenRegistrationCandidate, epoch captured: UInt64, delay: Duration) async throws {
        guard isDesired(candidate, epoch: captured) else { throw CancellationError() }
        let task = Task { [sleep] in try await sleep(delay) }
        waits[id] = task
        defer { if captured == epoch, tasks[id]?.id == operation { waits[id] = nil } }
        try await task.value
    }

    private func startPushIfNeeded() {
        guard pushTask == nil, desiredPush != nil, binding?.registerPushToStart != nil else { return }
        let captured = epoch
        pushTask = Task { [weak self] in await self?.drainPush(epoch: captured) }
    }

    private func drainPush(epoch captured: UInt64) async {
        defer { if captured == epoch { pushTask = nil } }
        while valid(captured), let token = desiredPush, let send = binding?.registerPushToStart {
            if registeredPush == token { desiredPush = nil; return }
            let result = await LiveActivityTokenRegistrationRetrier.run(attempt: { [weak self] in
                guard await self?.isDesiredPush(token, epoch: captured) == true else { return .terminal }
                return await send(token)
            }, sleep: { [weak self] delay in
                guard let self else { throw CancellationError() }
                try await self.pausePush(token: token, epoch: captured, delay: delay)
            })
            guard valid(captured) else { return }
            if result == .registered { registeredPush = token }
            guard desiredPush == token else { continue }
            desiredPush = nil
        }
    }

    private func isDesiredPush(_ token: String, epoch captured: UInt64) -> Bool { valid(captured) && desiredPush == token }

    private func pausePush(token: String, epoch captured: UInt64, delay: Duration) async throws {
        guard isDesiredPush(token, epoch: captured) else { throw CancellationError() }
        let task = Task { [sleep] in try await sleep(delay) }
        pushWait = task
        defer { if captured == epoch { pushWait = nil } }
        try await task.value
    }
}
