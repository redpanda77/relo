import Foundation

public struct ReadItemsResponse: Decodable, Equatable, Sendable {
    public struct Result: Decodable, Equatable, Sendable {
        public enum Outcome: String, Decodable, Sendable { case read, alreadyRead = "already_read", notFound = "not_found" }
        public let notificationId: String
        public let outcome: Outcome
        public init(notificationId: String, outcome: Outcome) { self.notificationId = notificationId; self.outcome = outcome }
    }
    public let results: [Result]
    public let unread: InboxUnreadSummary
    public init(results: [Result], unread: InboxUnreadSummary) { self.results = results; self.unread = unread }
    public func isValid(for requested: [String]) -> Bool {
        let ids = Set(results.map(\.notificationId))
        return !ids.isEmpty && results.count <= 250 && ids.count == results.count && ids.isSubset(of: Set(requested))
            && unread.account >= 0 && unread.projects.values.allSatisfy { $0 >= 0 }
    }
}

public protocol ReadItemsRemoteSource: Sendable {
    func markReadItems(_ notificationIDs: [String]) async throws -> ReadItemsResponse
}

public struct PendingReadState: Equatable, Sendable {
    public enum Issue: Equatable, Sendable { case full, storage, offline, authorization, invalidResponse }
    public var pendingIDs: Set<String> = []
    public var confirmedIDs: Set<String> = []
    public var issue: Issue?
    public init() {}
    public var locallyReadIDs: Set<String> { pendingIDs.union(confirmedIDs) }
}
