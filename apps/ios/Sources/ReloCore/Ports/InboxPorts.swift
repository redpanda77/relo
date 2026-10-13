import Foundation

public protocol InboxHistoryRemoteDataSource: Sendable {
    func fetchHistoryPage(before cursor: String?) async throws -> InboxHistoryPage
}

public protocol InboxCache: Sendable {
    func load() async throws -> InboxSnapshot
    func save(_ snapshot: InboxSnapshot) async throws
}
