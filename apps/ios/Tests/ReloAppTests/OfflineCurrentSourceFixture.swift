import ReloCore

/// Existing feature tests isolate current transport explicitly instead of making real DNS/network calls.
struct OfflineCurrentSourceFixture: CurrentStateSource {
    func fetchCurrent(ids: [String]?) async throws -> CurrentInboxResponse { throw InboxRemoteError.unavailable }
    func fetchCurrentPage(after cursor: String?) async throws -> CurrentInboxResponse { throw InboxRemoteError.unavailable }
    func fetchPending(after cursor: String?, limit: Int) async throws -> PendingCurrentPage { throw InboxRemoteError.unavailable }
    func changes() -> AsyncThrowingStream<CurrentChangeHint, Error> { AsyncThrowingStream { $0.finish() } }
}
