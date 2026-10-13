import ReloCore
import Foundation

/// Owns one authenticated current-state session. Inputs are captured by the composition root;
/// this owner never reads Keychain, UserDefaults, or mutable global credentials.
@MainActor
public final class SessionController {
    private let makeSource: (URL, String) -> any CurrentStateSource
    private let makeCache: (StorageScope) -> any CurrentStateCaching
    private let changed: @MainActor (CurrentRuntimeState?) -> Void
    private var current: CurrentStateController?
    private var credential: DeviceCredential?
    private var caches: [StorageScope: any CurrentStateCaching] = [:]
    private var foreground = true
    public var state: CurrentRuntimeState? { current?.state }

    public init(makeSource: @escaping (URL, String) -> any CurrentStateSource,
                makeCache: @escaping (StorageScope) -> any CurrentStateCaching,
                changed: @escaping @MainActor (CurrentRuntimeState?) -> Void) {
        self.makeSource = makeSource; self.makeCache = makeCache; self.changed = changed
    }

    public func ensure(origin: URL, credential: DeviceCredential) throws {
        let storage = try StorageScope(serverOrigin: origin, accountID: credential.accountId, deviceID: credential.deviceId)
        if current?.state.scope.storage == storage, self.credential == credential {
            if foreground { current?.activate() }
            return
        }
        stop()
        self.credential = credential
        let scope = SessionScope(storage: storage, credentialVersion: credential.credentialVersion)
        let cache: any CurrentStateCaching
        if let existing = caches[storage] { cache = existing }
        else { cache = makeCache(storage); caches[storage] = cache }
        current = CurrentStateController(scope: scope, source: makeSource(storage.serverOrigin, credential.accessToken), cache: cache) { [weak self] state in
            guard let self, self.current?.state.scope == state.scope else { return }
            self.changed(state)
        }
        if foreground { current?.activate() }
    }

    public func setForeground(_ value: Bool) {
        foreground = value
        if value { current?.activate() } else { current?.deactivate() }
    }

    public func stop() {
        let previous = current; current = nil; credential = nil
        previous?.deactivate(); changed(nil)
    }

    public func receive(_ hint: CurrentChangeHint) { current?.receive(hint) }
    public func refresh() async { await current?.refresh() }
    public func refresh(subjectIDs: [String]) async { await current?.refresh(subjectIDs: subjectIDs) }
    public func currentTime() -> Date? { current?.currentTime() }
    public func loadMoreCurrent() async { await current?.loadMoreCurrent() }
    public func loadMorePending() async { await current?.loadMorePending() }
    public func retryStorage() { current?.retryStorage() }

    /// A push wakeup reconciles once and opens no long-lived stream while backgrounded.
    public func reconcileInBackground() async -> Bool {
        guard let owner = current else { return false }
        return await withTaskCancellationHandler {
            guard !Task.isCancelled else { return false }
            if !foreground { owner.activate(observeChanges: false) }
            await owner.refresh()
            guard !Task.isCancelled, current === owner else { return false }
            let success = owner.state.connection == .current
            await owner.waitForPersistence()
            guard !Task.isCancelled, current === owner else { return false }
            if !foreground { owner.deactivate() }
            return success
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self, self.current === owner, !self.foreground else { return }
                owner.deactivate()
            }
        }
    }
}

public actor InMemoryCurrentStateCache: CurrentStateCaching {
    private var snapshot: CurrentCacheSnapshot
    public init(snapshot: CurrentCacheSnapshot = CurrentCacheSnapshot()) { self.snapshot = snapshot }
    public func load() -> CurrentCacheSnapshot { snapshot }
    public func save(_ snapshot: CurrentCacheSnapshot) { self.snapshot = snapshot }
}
