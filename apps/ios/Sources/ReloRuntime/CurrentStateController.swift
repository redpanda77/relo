import ReloCore
import Foundation

@MainActor
public final class CurrentStateController {
    public private(set) var state: CurrentRuntimeState
    private let source: any CurrentStateSource
    private let cache: any CurrentStateCaching
    private let changed: @MainActor (CurrentRuntimeState) -> Void
    private let instant: @Sendable () -> ContinuousClock.Instant
    private let wallTime: @Sendable () -> Date
    private let sleep: @Sendable (Duration) async throws -> Void
    private var deadlineClock = CurrentDeadlineClock()
    private var active = false
    private var epoch: UInt64 = 0
    private var hasFullRefresh = false
    private var wantsCurrentPage = false
    private var pendingIDs: Set<String> = []
    private var repairIDs: Set<String> = []
    private var nextSave: CurrentCacheSnapshot?
    private var cacheOpened = false
    private var loadTask: Task<Void, Never>?
    private var streamTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var expiryTask: Task<Void, Never>?
    private var saveTask: Task<Void, Never>?
    private var inventoryTask: Task<Void, Never>?
    private var recoveryTask: Task<Void, Never>?
    private var recoveryID: UInt64 = 0
    var backoff = ReconnectBackoff.standard
    var randomUnit: @Sendable () -> Double = { .random(in: 0...1) }
    private var inventoryEnabled = false
    private var resetInventory = false
    private var nextInventoryPage = false
    private var inventoryCursor: String?
    private var inventorySeen: Set<String> = []
    private var inventoryStartedAt: Date?

    public init(scope: SessionScope, source: any CurrentStateSource, cache: any CurrentStateCaching,
                changed: @escaping @MainActor (CurrentRuntimeState) -> Void = { _ in }) {
        self.state = CurrentRuntimeState(scope: scope); self.source = source; self.cache = cache
        self.changed = changed; self.instant = { .now }; self.wallTime = { Date() }
        self.sleep = { try await Task.sleep(for: $0) }
    }

    init(scope: SessionScope, source: any CurrentStateSource, cache: any CurrentStateCaching,
         instant: @escaping @Sendable () -> ContinuousClock.Instant, wallTime: @escaping @Sendable () -> Date,
         sleep: @escaping @Sendable (Duration) async throws -> Void,
         changed: @escaping @MainActor (CurrentRuntimeState) -> Void = { _ in }) {
        self.state = CurrentRuntimeState(scope: scope); self.source = source; self.cache = cache
        self.changed = changed; self.instant = instant; self.wallTime = wallTime; self.sleep = sleep
    }

    deinit {
        loadTask?.cancel(); streamTask?.cancel(); refreshTask?.cancel(); expiryTask?.cancel(); saveTask?.cancel(); inventoryTask?.cancel()
        recoveryTask?.cancel()
    }

    public func activate(observeChanges: Bool = true) {
        guard !active else {
            if observeChanges { enableInventory(); openStream(epoch: epoch) }
            return
        }
        active = true; epoch &+= 1
        inventoryEnabled = observeChanges
        let captured = epoch
        state.connection = .connecting; publish()
        openCache(epoch: captured)
        // Start the request immediately; neither disk access nor the stream handshake gates it.
        receive(.reconcile)
        if observeChanges { openStream(epoch: captured) }
    }

    private func openStream(epoch captured: UInt64) {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self, source] in
            do {
                for try await hint in source.changes() {
                    guard let self, self.owns(captured) else { return }
                    self.receive(hint)
                }
            } catch {
                guard let self, self.owns(captured) else { return }
                self.handle(error)
            }
            // A stream that ended is never left as a dead owner: the recovery loop reopens it.
            guard let self, self.epoch == captured else { return }
            self.streamTask = nil
            self.startRecoveryIfNeeded()
        }
    }

    /// Asks again right now (network came back, app became active). No-op unless we are offline.
    public func retryNow() {
        guard active, inventoryEnabled, state.connection == .offline else { return }
        recoveryTask?.cancel(); recoveryTask = nil
        reopenStreamIfEnded()
        receive(.reconcile)
    }

    private func reopenStreamIfEnded() { if inventoryEnabled, streamTask == nil { openStream(epoch: epoch) } }

    /// One backoff loop while a foreground session is offline; ends on the first success.
    private func startRecoveryIfNeeded() {
        guard active, inventoryEnabled, state.connection == .offline, recoveryTask == nil else { return }
        recoveryID &+= 1
        let id = recoveryID, captured = epoch
        recoveryTask = Task { [weak self, sleep] in
            var attempt = 0
            while !Task.isCancelled, self?.state.connection == .offline {
                guard let delay = self.map({ $0.backoff.delay(attempt: attempt, randomUnit: $0.randomUnit()) }) else { return }
                do { try await sleep(delay) } catch { break }
                guard let self, self.owns(captured), self.recoveryID == id, self.state.connection == .offline else { break }
                attempt += 1
                self.reopenStreamIfEnded()
                self.receive(.reconcile)
                await self.refreshTask?.value
            }
            guard let self, self.recoveryID == id else { return }
            self.recoveryTask = nil
        }
    }

    public func deactivate() {
        active = false; epoch &+= 1
        loadTask?.cancel(); streamTask?.cancel(); refreshTask?.cancel(); expiryTask?.cancel(); saveTask?.cancel(); inventoryTask?.cancel()
        recoveryTask?.cancel(); recoveryTask = nil; recoveryID &+= 1
        loadTask = nil; streamTask = nil; refreshTask = nil; expiryTask = nil; saveTask = nil
        hasFullRefresh = false; wantsCurrentPage = false; state.isLoadingCurrentPage = false
        pendingIDs = []; repairIDs = []; nextSave = nil
        inventoryTask = nil; inventoryEnabled = false; resetInventory = false; nextInventoryPage = false
        inventoryCursor = nil; inventorySeen = []; inventoryStartedAt = nil
        state.pendingConnection = .inactive; state.verifiedPending = [:]; state.pendingCountsAreCurrent = false
        deadlineClock = CurrentDeadlineClock(lastEvaluatedAt: state.snapshot.evaluatedAt)
        state.connection = .inactive; state.timeVerified = false; state.countsAreCurrent = false
        state.verifiedVersions = [:]
        publish()
    }

    public func receive(_ hint: CurrentChangeHint) {
        guard active, hint.isValid else { return }
        // A hint invalidates action authority immediately, before either read completes.
        if hint.subjectIds.isEmpty { state.verifiedVersions = [:]; state.verifiedPending = [:] }
        else {
            for id in hint.subjectIds { state.verifiedVersions.removeValue(forKey: id) }
            state.verifiedPending = state.verifiedPending.filter {
                !hint.subjectIds.contains(state.snapshot.pending?.entries[$0.key]?.item.subjectId ?? "")
            }
        }
        if hint.invalidateCounts { state.countsAreCurrent = false; state.pendingCountsAreCurrent = false }
        requestInventoryReset()
        publish()
        if hint.subjectIds.isEmpty { hasFullRefresh = true; pendingIDs = [] }
        else if !hasFullRefresh {
            pendingIDs.formUnion(hint.subjectIds)
            if pendingIDs.count > 50 { pendingIDs = []; hasFullRefresh = true }
        }
        guard refreshTask == nil else { return }
        let captured = epoch
        refreshTask = Task { [weak self] in await self?.drain(epoch: captured) }
    }

    public func refresh() async {
        receive(.reconcile)
        await refreshTask?.value
    }

    public func currentTime() -> Date? {
        deadlineClock.now(at: instant()) ?? state.snapshot.conservativeTimeAfterRestart(wallTime: wallTime())
    }

    public func refresh(subjectIDs: [String]) async {
        guard !subjectIDs.isEmpty else { return }
        receive(.init(subjectIds: subjectIDs, invalidateCounts: true))
        await refreshTask?.value
    }

    public func loadMoreCurrent() async {
        guard active, !state.isLoadingCurrentPage, !wantsCurrentPage, state.snapshot.metadata?.cursor != nil else { return }
        wantsCurrentPage = true
        if refreshTask == nil {
            let captured = epoch
            refreshTask = Task { [weak self] in await self?.drain(epoch: captured) }
        }
        await refreshTask?.value
    }

    public func loadMorePending() async {
        guard active, inventoryEnabled, inventoryCursor != nil else { return }
        nextInventoryPage = true; startInventoryTask()
        await inventoryTask?.value
    }

    private func enableInventory() {
        guard !inventoryEnabled else { return }
        inventoryEnabled = true; requestInventoryReset()
    }

    private func requestInventoryReset() {
        guard inventoryEnabled else { return }
        resetInventory = true; nextInventoryPage = false
        startInventoryTask()
    }

    private func startInventoryTask() {
        guard inventoryTask == nil else { return }
        let captured = epoch
        inventoryTask = Task { [weak self] in await self?.drainInventory(epoch: captured) }
    }

    private func drainInventory(epoch captured: UInt64) async {
        defer { if epoch == captured { inventoryTask = nil } }
        var retriedCursor = false
        while owns(captured), resetInventory || nextInventoryPage {
            let resetting = resetInventory
            let cursor = resetting ? nil : inventoryCursor
            resetInventory = false; nextInventoryPage = false
            if resetting { inventorySeen = []; inventoryStartedAt = nil; state.verifiedPending = [:] }
            state.pendingConnection = .connecting; publish()
            let started = instant()
            do {
                let response = try await source.fetchPending(after: cursor, limit: 50)
                guard owns(captured) else { return }
                try state.snapshot.applyPending(response, limit: 50)
                if inventoryStartedAt == nil { inventoryStartedAt = response.serverTime }
                inventorySeen.formUnion(response.items.map(\.id))
                inventoryCursor = response.cursor
                if !response.hasMore, let scanStart = inventoryStartedAt {
                    state.snapshot.finishPendingScan(seen: inventorySeen, startedAt: scanStart)
                }
                deadlineClock.synchronize(serverTime: response.serverTime, requestStarted: started, receivedAt: instant())
                state.timeVerified = true; state.pendingConnection = .current; state.pendingCountsAreCurrent = !resetInventory
                // A newer hint queued during this request requires another fresh pass.
                if !resetInventory {
                    for item in response.items where state.snapshot.pending?.entries[item.id]?.observedAt == response.serverTime {
                        state.verifiedPending[item.id] = response.serverTime
                    }
                }
                evaluateDeadlines(); publish(); scheduleSave(epoch: captured)
            } catch {
                guard owns(captured) else { return }
                if error as? InboxRemoteError == .cursorExpired, cursor != nil, !retriedCursor {
                    retriedCursor = true; resetInventory = true; continue
                }
                if error as? InboxRemoteError == .unauthorized { handle(error); return }
                state.pendingConnection = error as? InboxRemoteError == .incompatibleResponse ? .incompatible : .offline
                state.pendingCountsAreCurrent = false; publish()
                // A reset received during the failed read is new work, not a retry timer.
                // Consume it once; a second failure without another hint stops here.
                if state.pendingConnection == .offline, resetInventory { continue }
                return
            }
        }
    }

    public func waitForPersistence() async { await saveTask?.value }

    public func retryStorage() {
        guard active, loadTask == nil else { return }
        openCache(epoch: epoch)
    }

    private func owns(_ captured: UInt64) -> Bool { active && epoch == captured && !Task.isCancelled }

    private func openCache(epoch captured: UInt64) {
        cacheOpened = false
        loadTask = Task { [weak self, cache] in
            do {
                let cached = try await cache.load()
                guard let self, self.owns(captured) else { return }
                let previous = self.state.snapshot.subjects
                let previousPending = self.state.snapshot.pending?.entries ?? [:]
                self.state.snapshot.mergeKnowledge(from: cached)
                let uncertain = self.state.snapshot.subjects.compactMap { id, entry in
                    previous[id]?.projection.version == entry.projection.version ? nil : id
                } + (self.state.snapshot.pending?.entries.compactMap { id, entry in
                    previousPending[id] == entry ? nil : entry.item.subjectId
                } ?? [])
                if self.state.timeVerified, !uncertain.isEmpty {
                    self.state.countsAreCurrent = false
                    self.repairIDs.formUnion(uncertain)
                    self.receive(.init(subjectIds: Array(Set(uncertain).sorted().prefix(50)), invalidateCounts: true))
                }
                self.cacheOpened = true; self.state.persistence = .available
                self.evaluateDeadlines(); self.publish(); self.scheduleSave(epoch: captured)
            } catch {
                guard let self, self.owns(captured) else { return }
                self.state.persistence = .unavailable; self.publish()
            }
            guard let self, self.owns(captured) else { return }
            self.loadTask = nil
        }
    }

    private func drain(epoch captured: UInt64) async {
        defer { if epoch == captured { refreshTask = nil; state.isLoadingCurrentPage = false; publish() } }
        while owns(captured), hasFullRefresh || !pendingIDs.isEmpty || !repairIDs.isEmpty || wantsCurrentPage {
            let ids: [String]?, pageCursor: String?
            if hasFullRefresh { ids = nil; pageCursor = nil; hasFullRefresh = false }
            else if !pendingIDs.isEmpty { ids = Array(pendingIDs).sorted(); pageCursor = nil; pendingIDs = [] }
            else if !repairIDs.isEmpty { ids = Array(repairIDs.sorted().prefix(50)); pageCursor = nil; repairIDs.subtract(ids!) }
            else {
                wantsCurrentPage = false
                guard let cursor = state.snapshot.metadata?.cursor else { continue }
                ids = nil; pageCursor = cursor; state.isLoadingCurrentPage = true; publish()
            }
            let started = instant()
            do {
                let response: CurrentInboxResponse
                if let pageCursor { response = try await source.fetchCurrentPage(after: pageCursor) }
                else { response = try await source.fetchCurrent(ids: ids) }
                guard owns(captured) else { return }
                let knownIDs = Set(state.snapshot.subjects.keys)
                try state.snapshot.apply(response, requestedIDs: ids)
                deadlineClock.synchronize(serverTime: response.serverTime, requestStarted: started, receivedAt: instant())
                state.connection = .current; state.timeVerified = true; state.countsAreCurrent = !hasFullRefresh && pendingIDs.isEmpty
                if ids == nil && pageCursor == nil {
                    let unseen = knownIDs.subtracting(response.items.map(\.subjectId))
                    repairIDs.formUnion(unseen)
                    for id in unseen { state.verifiedVersions.removeValue(forKey: id) }
                } else if let ids {
                    repairIDs.subtract(ids)
                    for id in ids { state.verifiedVersions.removeValue(forKey: id) }
                }
                for item in response.items where !hasFullRefresh && !pendingIDs.contains(item.id)
                    && state.snapshot.subjects[item.id]?.projection.version == item.version {
                    state.verifiedVersions[item.id] = item.version
                }
                evaluateDeadlines(); publish(); scheduleSave(epoch: captured)
            } catch {
                guard owns(captured) else { return }
                if error as? InboxRemoteError == .cursorExpired, pageCursor != nil {
                    hasFullRefresh = true; continue
                }
                handle(error)
                // Preserve a new trigger that arrived while the old request was in flight.
                // Do not retry residual repair/page work after failure without a new hint.
                if state.connection == .offline, hasFullRefresh || !pendingIDs.isEmpty { continue }
                // The transport's bounded reconnect/reconciliation or an explicit refresh retries.
                // Failed requests never spin or block new hints behind history maintenance.
                return
            }
        }
    }

    private func handle(_ error: any Error) {
        if error is CancellationError { return }
        if error as? InboxRemoteError == .unauthorized {
            deactivate()
            state.connection = .unauthorized; state.timeVerified = false
        } else if error as? InboxRemoteError == .incompatibleResponse { state.connection = .incompatible }
        else { state.connection = .offline }
        state.countsAreCurrent = false; publish()
        startRecoveryIfNeeded()
    }

    private func evaluateDeadlines() {
        if let now = deadlineClock.now(at: instant()) ?? state.snapshot.conservativeTimeAfterRestart(wallTime: wallTime()) {
            state.snapshot.expire(at: now)
            state.verifiedVersions = state.verifiedVersions.filter { state.snapshot.subjects[$0.key]?.projection.version == $0.value }
            if let next = state.snapshot.metadata?.nextExpiryAt, next <= now { state.countsAreCurrent = false }
            state.verifiedPending = state.verifiedPending.filter { state.snapshot.pending?.entries[$0.key]?.observedAt == $0.value }
            if let next = state.snapshot.pending?.metadata?.nextExpiryAt, next <= now {
                state.pendingCountsAreCurrent = false; state.verifiedPending = [:]
            }
            armExpiry(after: now)
        }
    }

    private func armExpiry(after now: Date) {
        expiryTask?.cancel(); expiryTask = nil
        let deadlines = state.snapshot.subjects.values.flatMap {
            [$0.projection.currentUntil, $0.projection.freshUntil, $0.projection.interaction?.expiresAt].compactMap { $0 }
        } + [state.snapshot.metadata?.nextExpiryAt, state.snapshot.pending?.metadata?.nextExpiryAt].compactMap { $0 }
          + (state.snapshot.pending?.entries.values.map(\.validUntil) ?? [])
        guard let next = deadlines.filter({ $0 > now }).min() else { return }
        let captured = epoch, delay = Duration.seconds(next.timeIntervalSince(now))
        expiryTask = Task { [weak self, sleep] in
            do { try await sleep(delay) } catch { return }
            guard let self, self.owns(captured) else { return }
            self.evaluateDeadlines(); self.publish(); self.scheduleSave(epoch: captured)
            self.receive(.reconcile)
        }
    }

    private func scheduleSave(epoch captured: UInt64) {
        // Never overwrite unreadable retirement knowledge with a partial network projection.
        guard cacheOpened else { return }
        var value = state.snapshot; value.prepareForSave(wallTime: wallTime()); nextSave = value
        guard saveTask == nil else { return }
        saveTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.epoch == captured { self.saveTask = nil } }
            while self.owns(captured), let value = self.nextSave {
                self.nextSave = nil
                do {
                    try await self.cache.save(value)
                    guard self.owns(captured) else { return }
                    self.state.persistence = .available
                } catch {
                    guard self.owns(captured) else { return }
                    self.state.persistence = .unavailable; self.publish(); return
                }
                self.publish()
            }
        }
    }

    private func publish() { changed(state) }
}
