import Foundation

public struct CurrentRuntimeState: Equatable, Sendable {
    public enum Connection: Equatable, Sendable { case inactive, connecting, current, offline, unauthorized, incompatible }
    public enum Persistence: Equatable, Sendable { case loading, available, unavailable }
    public let scope: SessionScope
    public var snapshot = CurrentCacheSnapshot()
    public var connection: Connection = .inactive
    public var persistence: Persistence = .loading
    public var timeVerified = false
    public var countsAreCurrent = false
    public var verifiedVersions: [String: CurrentVersion] = [:]
    public var pendingConnection: Connection = .inactive
    public var verifiedPending: [String: Date] = [:]
    public var pendingCountsAreCurrent = false
    public var isLoadingCurrentPage = false

    public init(scope: SessionScope) { self.scope = scope }

    public func isSubjectVerified(_ id: String) -> Bool {
        guard timeVerified, let entry = snapshot.subjects[id] else { return false }
        return verifiedVersions[id] == entry.projection.version
    }
}
