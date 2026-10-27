import Foundation
import Observation

/// The notch's plan-usage state: what `relo usage --json` reads from this Mac's agents, kept fresh on a
/// cadence (30 s while a session is busy, 5 min otherwise, on looking at most every 15 s) and turned into
/// crossings. It shows only what the command reports; a failing or older command gives no accounts, no error.
@MainActor
@Observable
public final class UsageStore {
    public typealias Reader = @Sendable () async -> Data?
    public typealias Sleeper = @Sendable (TimeInterval) async -> Void

    public static let busyInterval: TimeInterval = 30
    public static let idleInterval: TimeInterval = 300
    public static let lookingInterval: TimeInterval = 15

    public private(set) var accounts: [UsageAccount] = []
    public private(set) var lastRefresh: Date?
    /// Called on the main actor for each crossing a refresh finds.
    @ObservationIgnored public var onCrossing: (@MainActor (UsageCrossing) -> Void)?

    @ObservationIgnored private let read: Reader
    @ObservationIgnored private let isBusy: @MainActor () -> Bool
    @ObservationIgnored private let now: @MainActor () -> Date
    @ObservationIgnored private let sleep: Sleeper
    @ObservationIgnored private var tracker = UsageCrossingTracker()
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var waiting: Task<Void, Never>?

    public init(read: @escaping Reader, isBusy: @escaping @MainActor () -> Bool = { false },
                now: @escaping @MainActor () -> Date = { Date() },
                sleep: @escaping Sleeper = { try? await Task.sleep(for: .seconds($0)) }) {
        self.read = read; self.isBusy = isBusy; self.now = now; self.sleep = sleep
    }

    /// The seconds to wait before the next refresh.
    public var interval: TimeInterval { isBusy() ? Self.busyInterval : Self.idleInterval }

    public func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refreshNow()
                let wait = self.interval
                await self.wait(wait)
            }
        }
    }

    private func wait(_ seconds: TimeInterval) async {
        let sleeper = sleep
        let task = Task { await sleeper(seconds) }
        waiting = task
        await task.value
        waiting = nil
    }

    /// A session started working: cut the current wait short so the next refresh comes within seconds.
    public func wake() { waiting?.cancel() }

    public func stop() {
        loop?.cancel()
        loop = nil
        waiting?.cancel()
    }

    /// The owner opened the notch or a list: refresh unless one ran in the last 15 seconds.
    public func refreshBecauseLooking() async {
        if let lastRefresh, now().timeIntervalSince(lastRefresh) < Self.lookingInterval { return }
        await refreshNow()
    }

    public func refreshNow() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        let data = await read()
        let moment = now()
        lastRefresh = moment
        // A failed run keeps what was read before (it dims as stale); a command too old for `usage` never read any.
        guard let data else { return }
        let fresh = UsageAccount.parse(data)
        let previous = Dictionary(uniqueKeysWithValues: accounts.map { ($0.id, $0) })
        let merged = fresh.map { account -> UsageAccount in
            // Nothing new for a window-less account: keep its last good reading so it dims as stale.
            guard account.windows.isEmpty, let old = previous[account.id], !old.windows.isEmpty else { return account }
            var kept = account
            kept.windows = old.windows
            kept.readAt = old.readAt
            return kept
        }
        let crossings = tracker.observe(merged, now: moment)
        accounts = merged.map { $0.live(now: moment) }
        for crossing in crossings { onCrossing?(crossing) }
    }
}
